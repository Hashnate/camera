export interface DeviceInfo {
  deviceSerial: string;
  deviceName: string;
  deviceType: string;
  status: number; // 1: online, 0: offline
  defence: number;
  deviceVersion?: string;
  channels?: DeviceChannelInfo[];
}

export interface DeviceChannelInfo {
  channelNo: number;
  channelName: string;
  status: number;
  isEncrypt: number;
  videoLevel?: number;
  picUrl?: string;
}

export interface StreamUrlResult {
  url: string;
  protocol: number; // 1: ezopen, 2: hls, 3: rtmp
  expireTime?: string | null;
  channelNo: number;
}

export interface SnapshotResult {
  picUrl: string;
  timestamp: string;
}

export interface ICameraProvider {
  authenticate(): Promise<string>;
  getDeviceList(pageStart?: number, pageSize?: number): Promise<DeviceInfo[]>;
  getDeviceInfo(deviceSerial: string): Promise<DeviceInfo | null>;
  getCameraChannels(deviceSerial: string): Promise<DeviceChannelInfo[]>;
  getStreamUrl(deviceSerial: string, channelNo?: number, protocol?: number): Promise<StreamUrlResult>;
  captureSnapshot(deviceSerial: string, channelNo?: number): Promise<SnapshotResult>;
  getConnectionStatus(deviceSerial: string): Promise<{ isOnline: boolean; rawStatus: number }>;
}

