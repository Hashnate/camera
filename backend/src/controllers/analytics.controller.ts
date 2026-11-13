import { Request, Response } from 'express';
import { prisma } from '../config/prisma.js';
import { CameraStatus } from '@prisma/client';

export const getOverviewStats = async (req: Request, res: Response) => {
  try {
    const today = new Date().toISOString().split('T')[0];

    const [
      totalEmployees,
      todayAttendance,
      totalCameras,
      onlineCameras,
      zones,
      recentAlerts,
    ] = await Promise.all([
      prisma.employee.count({ where: { isActive: true } }),
      prisma.attendanceRecord.findMany({ where: { date: today } }),
      prisma.camera.count(),
      prisma.camera.count({ where: { status: CameraStatus.ONLINE } }),
      prisma.officeZone.findMany({
        include: {
          occupancyRecords: {
            orderBy: { recordedAt: 'desc' },
            take: 1,
          },
        },
      }),
      prisma.cameraEvent.findMany({
        orderBy: { timestamp: 'desc' },
        take: 5,
        include: { camera: { select: { name: true, serialNumber: true } } },
      }),
    ]);

    const presentCount = todayAttendance.filter(r => r.checkIn !== null).length;
    const lateCount = todayAttendance.filter(r => r.isLate).length;
    const absentCount = Math.max(0, totalEmployees - presentCount);

    const occupiedZonesCount = zones.filter(
      z => z.occupancyRecords.length > 0 && z.occupancyRecords[0].personCount > 0
    ).length;

    return res.json({
      success: true,
      data: {
        summary: {
          totalEmployees,
          presentCount,
          absentCount,
          lateCount,
          totalCameras,
          onlineCameras,
          offlineCameras: Math.max(0, totalCameras - onlineCameras),
          totalZones: zones.length,
          occupiedZonesCount,
        },
        zones: zones.map(z => ({
          id: z.id,
          name: z.name,
          type: z.type,
          capacity: z.capacity,
          currentOccupancy: z.occupancyRecords[0]?.personCount || 0,
        })),
        recentAlerts,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const getZoneOccupancy = async (req: Request, res: Response) => {
  try {
    const zones = await prisma.officeZone.findMany({
      include: {
        occupancyRecords: {
          orderBy: { recordedAt: 'desc' },
          take: 24,
        },
      },
    });

    return res.json({ success: true, data: zones });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

/**
 * Ingestion endpoint for Python AI Computer Vision Engine
 */
export const recordDetectionEvent = async (req: Request, res: Response) => {
  try {
    const { cameraId, zoneId, channelNo, trackingId, eventType, confidence, personCount } = req.body;

    if (!cameraId || !eventType) {
      return res.status(400).json({ success: false, message: 'cameraId and eventType are required' });
    }

    const event = await prisma.detectionEvent.create({
      data: {
        cameraId,
        zoneId: zoneId || undefined,
        channelNo: channelNo || 1,
        trackingId: trackingId || undefined,
        eventType,
        confidence: confidence ? parseFloat(confidence) : undefined,
        personCount: personCount !== undefined ? parseInt(personCount, 10) : 1,
      },
    });

    // If an occupancy count event for a zone is posted, also record in OccupancyRecord
    if (zoneId && eventType === 'OCCUPANCY_COUNT') {
      const zone = await prisma.officeZone.findUnique({ where: { id: zoneId } });
      const count = personCount || 0;
      await prisma.occupancyRecord.create({
        data: {
          zoneId,
          personCount: count,
          isOverCapacity: zone ? count > zone.capacity : false,
        },
      });
    }

    return res.status(201).json({ success: true, data: event });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

