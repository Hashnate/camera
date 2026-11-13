import { PrismaClient, UserRole, CameraProviderType, CameraStatus, ZoneType, AttendanceStatus } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('[Seed] Starting WorkSight database initialization...');

  // 1. Company
  const company = await prisma.company.upsert({
    where: { code: 'WORKSIGHT-HQ' },
    update: {},
    create: {
      name: 'WorkSight Technologies Ltd',
      code: 'WORKSIGHT-HQ',
    },
  });

  // 2. Office
  let office = await prisma.office.findFirst({ where: { companyId: company.id } });
  if (!office) {
    office = await prisma.office.create({
      data: {
        companyId: company.id,
        name: 'Headquarters - Innovation Park',
        address: '42 Silicon Avenue, Floor 4',
        timezone: 'UTC',
      },
    });
  }

  // 3. Departments
  const deptNames = ['Engineering', 'Product & Design', 'Operations', 'Human Resources'];
  const depts: Record<string, string> = {};
  for (const name of deptNames) {
    let dept = await prisma.department.findFirst({
      where: { officeId: office.id, name },
    });
    if (!dept) {
      dept = await prisma.department.create({
        data: {
          officeId: office.id,
          name,
          code: name.substring(0, 3).toUpperCase(),
        },
      });
    }
    depts[name] = dept.id;
  }

  // 4. Work Schedule
  let schedule = await prisma.workSchedule.findFirst({ where: { officeId: office.id } });
  if (!schedule) {
    schedule = await prisma.workSchedule.create({
      data: {
        officeId: office.id,
        name: 'Standard Working Hours',
        startTime: '09:00',
        endTime: '17:00',
        graceMinutes: 15,
        workingDays: '1,2,3,4,5',
      },
    });
  }

  // 5. Super Admin User
  const passwordHash = await bcrypt.hash('Admin@123456', 10);
  const adminUser = await prisma.user.upsert({
    where: { email: 'admin@worksight.io' },
    update: { passwordHash },
    create: {
      email: 'admin@worksight.io',
      fullName: 'Chief Workplace Administrator',
      passwordHash,
      role: UserRole.SUPER_ADMIN,
      companyId: company.id,
    },
  });
  console.log(`[Seed] Super Admin created: ${adminUser.email} / Admin@123456`);

  // 6. Registered Employees
  const sampleEmployees = [
    { code: 'EMP-101', name: 'Alex Morgan', title: 'Senior Full Stack Engineer', dept: 'Engineering' },
    { code: 'EMP-102', name: 'Sarah Chen', title: 'Lead AI Engineer', dept: 'Engineering' },
    { code: 'EMP-103', name: 'David Kim', title: 'UI/UX Product Designer', dept: 'Product & Design' },
    { code: 'EMP-104', name: 'Elena Rostova', title: 'Operations Lead', dept: 'Operations' },
    { code: 'EMP-105', name: 'Marcus Johnson', title: 'HR Generalist', dept: 'Human Resources' },
  ];

  const createdEmployees = [];
  for (const emp of sampleEmployees) {
    const record = await prisma.employee.upsert({
      where: { employeeCode: emp.code },
      update: {
        fullName: emp.name,
        jobTitle: emp.title,
        departmentId: depts[emp.dept],
        workScheduleId: schedule.id,
      },
      create: {
        employeeCode: emp.code,
        fullName: emp.name,
        email: `${emp.name.toLowerCase().replace(' ', '.')}@worksight.io`,
        jobTitle: emp.title,
        departmentId: depts[emp.dept],
        workScheduleId: schedule.id,
        assignedZone: 'Main Workstation Area',
      },
    });
    createdEmployees.push(record);
  }

  // 7. Office Zones
  const zones = [
    { name: 'Engineering Workspace', type: ZoneType.DEVELOPMENT, cap: 15 },
    { name: 'Conference Room Alpha', type: ZoneType.MEETING_ROOM, cap: 8 },
    { name: 'Executive Reception', type: ZoneType.RECEPTION, cap: 4 },
    { name: 'Breakout Lounge', type: ZoneType.BREAK_AREA, cap: 6 },
  ];

  for (const z of zones) {
    let zoneRecord = await prisma.officeZone.findFirst({
      where: { officeId: office.id, name: z.name },
    });
    if (!zoneRecord) {
      zoneRecord = await prisma.officeZone.create({
        data: {
          officeId: office.id,
          name: z.name,
          type: z.type,
          capacity: z.cap,
        },
      });

      // Sample initial occupancy record
      await prisma.occupancyRecord.create({
        data: {
          zoneId: zoneRecord.id,
          personCount: Math.floor(Math.random() * (z.cap - 1)) + 1,
          isOverCapacity: false,
        },
      });
    }
  }

  // 8. Registered Official EZVIZ H7c Camera
  const ezvizSerial = 'BC7652775';
  const camera = await prisma.camera.upsert({
    where: { serialNumber: ezvizSerial },
    update: {
      name: 'EZVIZ H7c Dual-Lens (BC7652775)',
      model: 'CS-H7c-R100-8G44WF',
      status: CameraStatus.ONLINE,
      firmwareVer: 'V5.3.8 build 250812',
      location: 'Innovation Bay & Central Workstations',
      lastOnlineAt: new Date(),
    },
    create: {
      officeId: office.id,
      name: 'EZVIZ H7c Dual-Lens (BC7652775)',
      model: 'CS-H7c-R100-8G44WF',
      serialNumber: ezvizSerial,
      provider: CameraProviderType.EZVIZ,
      location: 'Innovation Bay & Central Workstations',
      status: CameraStatus.ONLINE,
      firmwareVer: 'V5.3.8 build 250812',
      lastOnlineAt: new Date(),
    },
  });

  // Channel 1: Wide-Angle Lens
  await prisma.cameraChannel.upsert({
    where: { cameraId_channelNo: { cameraId: camera.id, channelNo: 1 } },
    update: { channelName: 'Hashnate -WL (Wide Lens)', isEncrypted: false, status: 0 },
    create: {
      cameraId: camera.id,
      channelNo: 1,
      channelName: 'Hashnate -WL (Wide Lens)',
      isEncrypted: false,
      status: 0,
    },
  });

  // Channel 2: Pan-Tilt Lens
  await prisma.cameraChannel.upsert({
    where: { cameraId_channelNo: { cameraId: camera.id, channelNo: 2 } },
    update: { channelName: 'Hashnate -PT (Pan-Tilt Lens)', isEncrypted: false, status: 0 },
    create: {
      cameraId: camera.id,
      channelNo: 2,
      channelName: 'Hashnate -PT (Pan-Tilt Lens)',
      isEncrypted: false,
      status: 0,
    },
  });

  console.log(`[Seed] EZVIZ Dual-Lens Camera configured: ${camera.name} (${camera.serialNumber}) with 2 channels`);

  // 9. Today's Attendance Records
  const today = new Date().toISOString().split('T')[0];
  const now = new Date();

  // Alex Morgan (Present on time: 08:52)
  const alexIn = new Date(now);
  alexIn.setHours(8, 52, 0, 0);
  await prisma.attendanceRecord.upsert({
    where: { employeeId_date: { employeeId: createdEmployees[0].id, date: today } },
    update: {},
    create: {
      employeeId: createdEmployees[0].id,
      date: today,
      checkIn: alexIn,
      status: AttendanceStatus.PRESENT,
      isLate: false,
    },
  });

  // Sarah Chen (Present on time: 08:58)
  const sarahIn = new Date(now);
  sarahIn.setHours(8, 58, 0, 0);
  await prisma.attendanceRecord.upsert({
    where: { employeeId_date: { employeeId: createdEmployees[1].id, date: today } },
    update: {},
    create: {
      employeeId: createdEmployees[1].id,
      date: today,
      checkIn: sarahIn,
      status: AttendanceStatus.PRESENT,
      isLate: false,
    },
  });

  // David Kim (Late: 09:24)
  const davidIn = new Date(now);
  davidIn.setHours(9, 24, 0, 0);
  await prisma.attendanceRecord.upsert({
    where: { employeeId_date: { employeeId: createdEmployees[2].id, date: today } },
    update: {},
    create: {
      employeeId: createdEmployees[2].id,
      date: today,
      checkIn: davidIn,
      status: AttendanceStatus.LATE,
      isLate: true,
    },
  });

  console.log('[Seed] Database initialization complete!');
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

