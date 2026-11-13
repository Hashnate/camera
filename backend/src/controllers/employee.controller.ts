import { Request, Response } from 'express';
import { prisma } from '../config/prisma.js';

export const getEmployees = async (req: Request, res: Response) => {
  try {
    const employees = await prisma.employee.findMany({
      include: {
        department: true,
        workSchedule: true,
      },
      orderBy: { fullName: 'asc' },
    });

    return res.json({ success: true, count: employees.length, data: employees });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const getEmployeeById = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const employee = await prisma.employee.findUnique({
      where: { id },
      include: {
        department: true,
        workSchedule: true,
        attendanceRecords: {
          orderBy: { date: 'desc' },
          take: 30,
        },
      },
    });

    if (!employee) {
      return res.status(404).json({ success: false, message: 'Employee not found' });
    }

    return res.json({ success: true, data: employee });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const createEmployee = async (req: Request, res: Response) => {
  try {
    const { employeeCode, fullName, email, jobTitle, departmentId, workScheduleId, assignedZone } = req.body;

    if (!employeeCode || !fullName || !departmentId) {
      return res.status(400).json({
        success: false,
        message: 'employeeCode, fullName, and departmentId are required',
      });
    }

    const existing = await prisma.employee.findUnique({ where: { employeeCode } });
    if (existing) {
      return res.status(409).json({ success: false, message: 'Employee code already exists' });
    }

    const employee = await prisma.employee.create({
      data: {
        employeeCode,
        fullName,
        email,
        jobTitle: jobTitle || 'Team Member',
        departmentId,
        workScheduleId,
        assignedZone,
      },
      include: {
        department: true,
        workSchedule: true,
      },
    });

    return res.status(201).json({ success: true, data: employee });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const updateEmployee = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { fullName, email, jobTitle, departmentId, workScheduleId, assignedZone, isActive } = req.body;

    const updated = await prisma.employee.update({
      where: { id },
      data: {
        fullName,
        email,
        jobTitle,
        departmentId,
        workScheduleId,
        assignedZone,
        isActive,
      },
      include: {
        department: true,
        workSchedule: true,
      },
    });

    return res.json({ success: true, data: updated });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

export const deleteEmployee = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await prisma.employee.delete({ where: { id } });
    return res.json({ success: true, message: 'Employee removed successfully' });
  } catch (err: any) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

