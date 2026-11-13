import axios from 'axios';
import { ENV } from '../config/env.js';
import { ICameraProvider, DeviceInfo, DeviceChannelInfo, StreamUrlResult, SnapshotResult } from './camera.interface.js';

export class EZVIZProvider implements ICameraProvider {
  private appKey: string;
  private appSecret: string;
  private baseUrl: string;
  private cachedToken: string | null = null;
  private tokenExpiresAt: number = 0;

  constructor() {
    this.appKey = ENV.EZVIZ_APP_KEY;
    this.appSecret = ENV.EZVIZ_APP_SECRET;
    this.baseUrl = ENV.EZVIZ_API_BASE_URL.replace(/\/$/, '');
    if (ENV.EZVIZ_ACCESS_TOKEN) {
      this.cachedToken = ENV.EZVIZ_ACCESS_TOKEN;
      // Default to 6 days cache if pre-supplied
      this.tokenExpiresAt = Date.now() + 6 * 24 * 3600 * 1000;
    }
  }

  /**
   * Retrieves or refreshes the EZVIZ Open Platform accessToken
   */
  async authenticate(): Promise<string> {
    if (this.cachedToken && Date.now() < this.tokenExpiresAt - 60000) {
      return this.cachedToken;
    }

    try {
      const url = `${this.baseUrl}/api/lapp/token/get`;
      const params = new URLSearchParams();
      params.append('appKey', this.appKey);
      params.append('appSecret', this.appSecret);

      const response = await axios.post(url, params.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10000,
      });

      if (response.data?.code === '200' && response.data?.data?.accessToken) {
        this.cachedToken = response.data.data.accessToken;
        this.tokenExpiresAt = response.data.data.expireTime || (Date.now() + 7 * 24 * 3600 * 1000);
        return this.cachedToken!;
      }

      throw new Error(`EZVIZ Auth failed: [${response.data?.code}] ${response.data?.msg || 'Unknown error'}`);
    } catch (err: any) {
      console.error('[EZVIZProvider] Error authenticating:', err.message);
      if (this.cachedToken) {
        // Fallback to pre-configured token if API call encounters network issue
        return this.cachedToken;
      }
      throw err;
    }
  }

  /**
   * Fetches list of registered devices on the EZVIZ account
   */
  async getDeviceList(pageStart: number = 0, pageSize: number = 10): Promise<DeviceInfo[]> {
    const token = await this.authenticate();
    const url = `${this.baseUrl}/api/lapp/device/list`;
    const params = new URLSearchParams();
    params.append('accessToken', token);
    params.append('pageStart', pageStart.toString());
    params.append('pageSize', pageSize.toString());

    const response = await axios.post(url, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000,
    });

    if (response.data?.code === '200' && Array.isArray(response.data?.data)) {
      return response.data.data.map((d: any) => ({
        deviceSerial: d.deviceSerial,
        deviceName: d.deviceName,
        deviceType: d.deviceType,
        status: d.status,
        defence: d.defence,
        deviceVersion: d.deviceVersion,
      }));
    }

    throw new Error(`Failed to list devices: [${response.data?.code}] ${response.data?.msg}`);
  }

  /**
   * Fetches detailed device information
   */
  async getDeviceInfo(deviceSerial: string): Promise<DeviceInfo | null> {
    const devices = await this.getDeviceList(0, 50);
    const device = devices.find(d => d.deviceSerial.toUpperCase() === deviceSerial.toUpperCase());
    if (!device) return null;

    try {
      const channels = await this.getCameraChannels(deviceSerial);
      device.channels = channels;
    } catch (e) {
      console.warn(`[EZVIZProvider] Could not load channels for ${deviceSerial}:`, e);
    }

    return device;
  }

  /**
   * Fetches all channels for the camera (e.g. Channel 1: Wide Lens, Channel 2: Pan-Tilt)
   */
  async getCameraChannels(deviceSerial: string): Promise<DeviceChannelInfo[]> {
    const token = await this.authenticate();
    const url = `${this.baseUrl}/api/lapp/camera/list`;
    const params = new URLSearchParams();
    params.append('accessToken', token);

    const response = await axios.post(url, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000,
    });

    if (response.data?.code === '200' && Array.isArray(response.data?.data)) {
      return response.data.data
        .filter((c: any) => c.deviceSerial.toUpperCase() === deviceSerial.toUpperCase())
        .map((c: any) => ({
          channelNo: c.channelNo,
          channelName: c.channelName || `Channel ${c.channelNo}`,
          status: c.status,
          isEncrypt: c.isEncrypt ?? 0,
          videoLevel: c.videoLevel,
          picUrl: c.picUrl,
        }));
    }

    return [];
  }

  /**
   * Obtains live streaming address (Protocol 2 = HLS .m3u8, Protocol 1 = ezopen)
   */
  async getStreamUrl(deviceSerial: string, channelNo: number = 1, protocol: number = 2): Promise<StreamUrlResult> {
    const token = await this.authenticate();
    const url = `${this.baseUrl}/api/lapp/live/address/get`;
    const params = new URLSearchParams();
    params.append('accessToken', token);
    params.append('deviceSerial', deviceSerial);
    params.append('channelNo', channelNo.toString());
    params.append('protocol', protocol.toString());
    params.append('quality', '1'); // 1: HD

    const response = await axios.post(url, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 12000,
    });

    if (response.data?.code === '200' && response.data?.data?.url) {
      return {
        url: response.data.data.url,
        protocol,
        expireTime: response.data.data.expireTime,
        channelNo,
      };
    }

    throw new Error(`Failed to get stream URL: [${response.data?.code}] ${response.data?.msg || 'Unknown error'}`);
  }

  /**
   * Captures an instant snapshot frame from the camera
   */
  async captureSnapshot(deviceSerial: string, channelNo: number = 1): Promise<SnapshotResult> {
    const token = await this.authenticate();
    const url = `${this.baseUrl}/api/lapp/device/capture`;
    const params = new URLSearchParams();
    params.append('accessToken', token);
    params.append('deviceSerial', deviceSerial);
    params.append('channelNo', channelNo.toString());

    const response = await axios.post(url, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000,
    });

    if (response.data?.code === '200' && response.data?.data?.picUrl) {
      return {
        picUrl: response.data.data.picUrl,
        timestamp: new Date().toISOString(),
      };
    }

    throw new Error(`Failed to capture snapshot: [${response.data?.code}] ${response.data?.msg || 'Unknown error'}`);
  }

  /**
   * Verifies camera online status
   */
  async getConnectionStatus(deviceSerial: string): Promise<{ isOnline: boolean; rawStatus: number }> {
    const device = await this.getDeviceInfo(deviceSerial);
    if (!device) {
      return { isOnline: false, rawStatus: 0 };
    }
    return {
      isOnline: device.status === 1,
      rawStatus: device.status,
    };
  }
}

export const ezvizProvider = new EZVIZProvider();

