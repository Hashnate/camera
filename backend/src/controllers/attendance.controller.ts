import { Request, Response } from 'express';
import { prisma } from '../config/prisma.js';
import { AttendanceStatus, CorrectionStatus } from '@prisma/client';

export const getTodayAttendance = async (req: Request, res: Response) => {
  try {
    const today = new Date().toISOString().split('T')[0];

    const records = await prisma.attendanceRecord.findMany({
      where: { date: today },
      include: {
        employee: {
          include: {
            department: true,
            workSchedule: true,
          },
        },
        corrections: true,
      },
      orderBy: { checkIn: 'desc' },
    });

    const totalEmployees = await prisma.employee.count({ where: { isActive: true } });
    const presentCount = records.filter(r => r.status === AttendanceStatus.PRESENT || r.status === AttendanceStatus.LATE).length;
    const lateCount = records.filter(r => r.isLate).length;
    const absentCount = Math.max(0, totalEmployees - presentCount);

    return res.json({
      success: true,
      date: today,
      stats: {
        totalEmployees,
        presentCount,
        lateCount,
        absentCount,
      },
      records,
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const getAttendanceHistory = async (req: Request, res: Response) => {
  try {
    const { startDate, endDate, departmentId } = req.query;

    const where: any = {};
    if (startDate && endDate) {
      where.date = {
        gte: String(startDate),
        lte: String(endDate),
      };
    }
    if (departmentId) {
      where.employee = { departmentId: String(departmentId) };
    }

    const records = await prisma.attendanceRecord.findMany({
      where,
      include: {
        employee: {
          include: { department: true },
        },
        corrections: true,
      },
      orderBy: { date: 'desc' },
      take: 100,
    });

    return res.json({ success: true, count: records.length, data: records });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const checkIn = async (req: Request, res: Response) => {
  try {
    const { employeeId } = req.body;
    if (!employeeId) {
      return res.status(400).json({ success: false, message: 'employeeId is required' });
    }

    const employee = await prisma.employee.findUnique({
      where: { id: employeeId },
      include: { workSchedule: true },
    });

    if (!employee) {
      return res.status(404).json({ success: false, message: 'Employee not found' });
    }

    const now = new Date();
    const today = now.toISOString().split('T')[0];

    // Check if already checked in today
    const existing = await prisma.attendanceRecord.findUnique({
      where: {
        employeeId_date: {
          employeeId: employee.id,
          date: today,
        },
      },
    });

    if (existing && existing.checkIn) {
      return res.status(400).json({
        success: false,
        message: 'Employee already checked in today',
        record: existing,
      });
    }

    // Calculate late arrival
    let isLate = false;
    if (employee.workSchedule) {
      const [schedHour, schedMinute] = employee.workSchedule.startTime.split(':').map(Number);
      const graceMinutes = employee.workSchedule.graceMinutes || 15;

      const scheduleTime = new Date(now);
      scheduleTime.setHours(schedHour, schedMinute + graceMinutes, 0, 0);

      if (now > scheduleTime) {
        isLate = true;
      }
    }

    const record = await prisma.attendanceRecord.upsert({
      where: {
        employeeId_date: {
          employeeId: employee.id,
          date: today,
        },
      },
      update: {
        checkIn: now,
        isLate,
        status: isLate ? AttendanceStatus.LATE : AttendanceStatus.PRESENT,
      },
      create: {
        employeeId: employee.id,
        date: today,
        checkIn: now,
        isLate,
        status: isLate ? AttendanceStatus.LATE : AttendanceStatus.PRESENT,
      },
    });

    return res.status(200).json({ success: true, message: 'Check-in recorded', data: record });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const checkOut = async (req: Request, res: Response) => {
  try {
    const { employeeId } = req.body;
    if (!employeeId) {
      return res.status(400).json({ success: false, message: 'employeeId is required' });
    }

    const now = new Date();
    const today = now.toISOString().split('T')[0];

    const record = await prisma.attendanceRecord.findUnique({
      where: {
        employeeId_date: {
          employeeId,
          date: today,
        },
      },
    });

    if (!record || !record.checkIn) {
      return res.status(400).json({ success: false, message: 'No check-in found for today' });
    }

    const diffMinutes = Math.round((now.getTime() - new Date(record.checkIn).getTime()) / (1000 * 60));

    const updated = await prisma.attendanceRecord.update({
      where: { id: record.id },
      data: {
        checkOut: now,
        totalMinutes: Math.max(0, diffMinutes),
      },
    });

    return res.json({ success: true, message: 'Check-out recorded', data: updated });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const requestCorrection = async (req: Request, res: Response) => {
  try {
    const { attendanceRecordId, requestedCheckIn, requestedCheckOut, reason } = req.body;

    if (!attendanceRecordId || !reason) {
      return res.status(400).json({ success: false, message: 'Record ID and reason are required' });
    }

    const correction = await prisma.attendanceCorrection.create({
      data: {
        attendanceRecordId,
        requestedCheckIn: requestedCheckIn ? new Date(requestedCheckIn) : undefined,
        requestedCheckOut: requestedCheckOut ? new Date(requestedCheckOut) : undefined,
        reason,
        status: CorrectionStatus.PENDING,
      },
    });

    return res.status(201).json({ success: true, data: correction });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

