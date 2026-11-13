import { Request, Response } from 'express';
import { prisma } from '../config/prisma.js';
import { ezvizProvider } from '../providers/ezviz.provider.js';
import { CameraStatus, CameraProviderType } from '@prisma/client';

export const getCameras = async (req: Request, res: Response) => {
  try {
    const cameras = await prisma.camera.findMany({
      include: {
        channels: {
          orderBy: { channelNo: 'asc' },
        },
        office: {
          select: { id: true, name: true, address: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return res.json({ success: true, count: cameras.length, data: cameras });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const getCameraById = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const camera = await prisma.camera.findUnique({
      where: { id },
      include: {
        channels: { orderBy: { channelNo: 'asc' } },
        office: true,
        events: { orderBy: { timestamp: 'desc' }, take: 10 },
      },
    });

    if (!camera) {
      return res.status(404).json({ success: false, message: 'Camera not found' });
    }

    return res.json({ success: true, data: camera });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * Synchronize camera list & status from official EZVIZ Open Platform
 */
export const syncEZVIZ = async (req: Request, res: Response) => {
  try {
    const ezvizDevices = await ezvizProvider.getDeviceList(0, 50);

    const defaultOffice = await prisma.office.findFirst();
    if (!defaultOffice) {
      return res.status(400).json({ success: false, message: 'No office found. Please create an office first.' });
    }

    const syncedCameras = [];

    for (const dev of ezvizDevices) {
      const isOnline = dev.status === 1;

      // Upsert Camera
      const camera = await prisma.camera.upsert({
        where: { serialNumber: dev.deviceSerial },
        update: {
          name: dev.deviceName || `EZVIZ ${dev.deviceType}`,
          model: dev.deviceType,
          status: isOnline ? CameraStatus.ONLINE : CameraStatus.OFFLINE,
          firmwareVer: dev.deviceVersion,
          lastOnlineAt: isOnline ? new Date() : undefined,
        },
        create: {
          officeId: defaultOffice.id,
          name: dev.deviceName || `EZVIZ ${dev.deviceType}`,
          model: dev.deviceType,
          serialNumber: dev.deviceSerial,
          provider: CameraProviderType.EZVIZ,
          location: 'Office Main Hall',
          status: isOnline ? CameraStatus.ONLINE : CameraStatus.OFFLINE,
          firmwareVer: dev.deviceVersion,
          lastOnlineAt: isOnline ? new Date() : undefined,
        },
      });

      // Fetch and upsert channels (e.g. Channel 1 Wide-Lens, Channel 2 Pan-Tilt)
      try {
        const channels = await ezvizProvider.getCameraChannels(dev.deviceSerial);
        for (const ch of channels) {
          await prisma.cameraChannel.upsert({
            where: {
              cameraId_channelNo: {
                cameraId: camera.id,
                channelNo: ch.channelNo,
              },
            },
            update: {
              channelName: ch.channelName,
              isEncrypted: ch.isEncrypt === 1,
              status: ch.status,
              snapshotUrl: ch.picUrl,
            },
            create: {
              cameraId: camera.id,
              channelNo: ch.channelNo,
              channelName: ch.channelName,
              isEncrypted: ch.isEncrypt === 1,
              status: ch.status,
              snapshotUrl: ch.picUrl,
            },
          });
        }
      } catch (chErr) {
        console.warn(`[SyncEZVIZ] Could not sync channels for ${dev.deviceSerial}:`, chErr);
      }

      syncedCameras.push(camera);
    }

    return res.json({
      success: true,
      message: `Successfully synchronized ${syncedCameras.length} device(s) with EZVIZ Open Platform`,
      data: syncedCameras,
    });
  } catch (err: any) {
    console.error('syncEZVIZ error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * Fetch authorized live stream URL from EZVIZ
 * Protocol: 2 (HLS .m3u8, default and standard for web), 1 (ezopen)
 */
export const getStreamUrl = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const channelNo = parseInt((req.query.channel as string) || '1', 10);
    const protocol = parseInt((req.query.protocol as string) || '2', 10);

    const camera = await prisma.camera.findUnique({
      where: { id },
      include: { channels: true },
    });

    if (!camera) {
      return res.status(404).json({ success: false, message: 'Camera not found' });
    }

    if (camera.provider !== CameraProviderType.EZVIZ) {
      return res.status(400).json({
        success: false,
        message: `Provider ${camera.provider} live streaming is not currently supported. Only EZVIZ is integrated.`,
      });
    }

    // Call official EZVIZ Open Platform API to get live URL
    const streamResult = await ezvizProvider.getStreamUrl(camera.serialNumber, channelNo, protocol);

    // Update channel record in DB with recent stream URL
    await prisma.cameraChannel.updateMany({
      where: {
        cameraId: camera.id,
        channelNo: channelNo,
      },
      data: {
        hlsUrl: protocol === 2 ? streamResult.url : undefined,
        ezopenUrl: protocol === 1 ? streamResult.url : undefined,
      },
    });

    return res.json({
      success: true,
      data: {
        cameraId: camera.id,
        serialNumber: camera.serialNumber,
        channelNo,
        protocol,
        streamUrl: streamResult.url,
        expireTime: streamResult.expireTime,
      },
    });
  } catch (err: any) {
    console.error('[getStreamUrl] Error:', err.message);
    return res.status(502).json({
      success: false,
      message: `EZVIZ stream error: ${err.message}`,
    });
  }
};

/**
 * Capture live frame snapshot
 */
export const captureSnapshot = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const channelNo = parseInt((req.query.channel as string) || '1', 10);

    const camera = await prisma.camera.findUnique({ where: { id } });
    if (!camera) {
      return res.status(404).json({ success: false, message: 'Camera not found' });
    }

    const snapshot = await ezvizProvider.captureSnapshot(camera.serialNumber, channelNo);

    // Save snapshot URL to channel
    await prisma.cameraChannel.updateMany({
      where: { cameraId: camera.id, channelNo },
      data: { snapshotUrl: snapshot.picUrl },
    });

    return res.json({
      success: true,
      data: {
        picUrl: snapshot.picUrl,
        timestamp: snapshot.timestamp,
        channelNo,
      },
    });
  } catch (err: any) {
    return res.status(502).json({ success: false, message: err.message });
  }
};

/**
 * Check camera live connection status
 */
export const getCameraStatus = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const camera = await prisma.camera.findUnique({ where: { id } });
    if (!camera) {
      return res.status(404).json({ success: false, message: 'Camera not found' });
    }

    const { isOnline, rawStatus } = await ezvizProvider.getConnectionStatus(camera.serialNumber);

    const updatedStatus = isOnline ? CameraStatus.ONLINE : CameraStatus.OFFLINE;

    if (camera.status !== updatedStatus) {
      await prisma.camera.update({
        where: { id },
        data: {
          status: updatedStatus,
          lastOnlineAt: isOnline ? new Date() : camera.lastOnlineAt,
        },
      });

      // Record event
      await prisma.cameraEvent.create({
        data: {
          cameraId: camera.id,
          eventType: isOnline ? 'CONNECTED' : 'DISCONNECTED',
          message: `Camera status transitioned to ${updatedStatus} (raw: ${rawStatus})`,
        },
      });
    }

    return res.json({
      success: true,
      data: {
        id: camera.id,
        serialNumber: camera.serialNumber,
        isOnline,
        status: updatedStatus,
        lastOnlineAt: camera.lastOnlineAt,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

