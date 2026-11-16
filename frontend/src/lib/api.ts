const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api';

export function getStoredToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('worksight_token');
}

export function setStoredToken(token: string | null) {
  if (typeof window === 'undefined') return;
  if (token) {
    localStorage.setItem('worksight_token', token);
  } else {
    localStorage.removeItem('worksight_token');
  }
}

export async function apiFetch<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const token = getStoredToken();
  const headers = new Headers(options.headers || {});

  if (!headers.has('Content-Type') && !(options.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }

  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const res = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers,
    credentials: 'omit',
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(data.message || `HTTP error ${res.status}`);
  }

  return data;
}

export const api = {
  // Auth
  login: (email: string, password: string) =>
    apiFetch<{ success: boolean; token: string; user: any }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  logout: () =>
    apiFetch<{ success: boolean }>('/auth/logout', {
      method: 'POST',
    }),
  getMe: () =>
    apiFetch<{ success: boolean; user: any }>('/auth/me'),

  // Cameras
  getCameras: () =>
    apiFetch<{ success: boolean; count: number; data: any[] }>('/cameras'),
  getCameraById: (id: string) =>
    apiFetch<{ success: boolean; data: any }>(`/cameras/${id}`),
  syncEZVIZ: () =>
    apiFetch<{ success: boolean; message: string; data: any[] }>('/cameras/sync-ezviz', {
      method: 'POST',
    }),
  getStreamUrl: (cameraId: string, channel: number = 1, protocol: number = 2) =>
    apiFetch<{
      success: boolean;
      data: {
        cameraId: string;
        serialNumber: string;
        channelNo: number;
        protocol: number;
        streamUrl: string;
        expireTime?: string;
      };
    }>(`/cameras/${cameraId}/stream?channel=${channel}&protocol=${protocol}`),
  captureSnapshot: (cameraId: string, channel: number = 1) =>
    apiFetch<{
      success: boolean;
      data: { picUrl: string; timestamp: string; channelNo: number };
    }>(`/cameras/${cameraId}/snapshot?channel=${channel}`),
  getCameraStatus: (cameraId: string) =>
    apiFetch<{ success: boolean; data: any }>(`/cameras/${cameraId}/status`),

  // Employees
  getEmployees: () =>
    apiFetch<{ success: boolean; count: number; data: any[] }>('/employees'),
  getEmployeeFormOptions: () =>
    apiFetch<{
      success: boolean;
      data: {
        departments: { id: string; name: string }[];
        workSchedules: { id: string; name: string; startTime: string; endTime: string }[];
      };
    }>('/employees/form-options'),
  createEmployee: (payload: any) =>
    apiFetch<{ success: boolean; data: any }>('/employees', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  // Attendance
  getTodayAttendance: () =>
    apiFetch<{ success: boolean; date: string; stats: any; records: any[] }>('/attendance/today'),
  getAttendanceHistory: (startDate?: string, endDate?: string) => {
    const params = new URLSearchParams();
    if (startDate) params.set('startDate', startDate);
    if (endDate) params.set('endDate', endDate);
    return apiFetch<{ success: boolean; count: number; data: any[] }>(`/attendance/history?${params}`);
  },
  checkIn: (employeeId: string) =>
    apiFetch<{ success: boolean; message: string; data: any }>('/attendance/check-in', {
      method: 'POST',
      body: JSON.stringify({ employeeId }),
    }),
  checkOut: (employeeId: string) =>
    apiFetch<{ success: boolean; message: string; data: any }>('/attendance/check-out', {
      method: 'POST',
      body: JSON.stringify({ employeeId }),
    }),

  // Face enrolment (automatic attendance)
  getFaceEnrollments: () =>
    apiFetch<{ success: boolean; maxSamples: number; data: FaceEnrollmentSummary[] }>('/faces'),
  enrollFace: (employeeId: string, image: Blob, source: 'UPLOAD' | 'WEBCAM') => {
    const form = new FormData();
    form.append('image', image, 'face.jpg');
    form.append('consent', 'true');
    form.append('source', source);
    return apiFetch<{ success: boolean; message: string; data: FaceEnrollmentSummary }>(`/faces/${employeeId}`, {
      method: 'POST',
      body: form,
    });
  },
  revokeFace: (employeeId: string) =>
    apiFetch<{ success: boolean; message: string; deleted: number }>(`/faces/${employeeId}`, {
      method: 'DELETE',
    }),

  // Recognition feed & AI worker status
  getRecognitionEvents: (limit = 20, actions?: string) =>
    apiFetch<{ success: boolean; count: number; data: RecognitionEvent[] }>(
      `/recognition/events?limit=${limit}${actions ? `&actions=${actions}` : ''}`
    ),
  getRecognitionStatus: () =>
    apiFetch<{ success: boolean; data: RecognitionStatus }>('/recognition/status'),

  // Analytics
  getOverviewStats: () =>
    apiFetch<{ success: boolean; data: any }>('/analytics/overview'),
  getZoneOccupancy: () =>
    apiFetch<{ success: boolean; data: any[] }>('/analytics/occupancy'),
};


export interface FaceEnrollmentSummary {
  employeeId: string;
  samples: number;
  consentGivenAt: string;
  lastEnrolledAt: string;
}

export interface RecognitionEvent {
  id: string;
  employeeId: string;
  cameraId: string | null;
  channelNo: number;
  similarity: number;
  action: 'CHECK_IN' | 'CHECK_OUT' | 'SEEN' | 'IGNORED_INACTIVE';
  seenAt: string;
  employee: { id: string; fullName: string; employeeCode: string; jobTitle: string };
  camera: { id: string; name: string } | null;
}

export interface RecognitionChannelStatus {
  cameraId: string;
  cameraName: string;
  channelNo: number;
  source: 'hls' | 'snapshot' | 'webcam' | 'file' | 'folder' | null;
  state: 'starting' | 'connecting' | 'running' | 'idle' | 'error';
  lastFrameAt: string | null;
  framesProcessed: number;
  facesDetected: number;
  lastError: string | null;
}

export interface RecognitionStatus {
  reachable: boolean;
  error?: string;
  workerEnabled?: boolean;
  running?: boolean;
  galleryEmployees?: number;
  lastError?: string | null;
  sourceOverride?: boolean;
  channels?: RecognitionChannelStatus[];
}

export interface WorkSession {
  start: string;
  end: string;
  minutes: number;
}

export interface WorkDayRow {
  employee: { id: string; fullName: string; employeeCode: string; jobTitle?: string; department: string | null };
  scheduledMinutes: number | null;
  state: 'IN_OFFICE' | 'LEFT' | 'ABSENT';
  date: string | null;
  measured: boolean;
  checkIn: string | null;
  lastSeen: string | null;
  insideMinutes: number;
  spanMinutes: number;
  awayMinutes: number;
  isLate: boolean;
  sessions: WorkSession[];
}

export interface WorkPeriodRow {
  employee: { id: string; fullName: string; employeeCode: string; department: string | null };
  daysPresent: number;
  lateDays: number;
  totalInsideMinutes: number;
  totalSpanMinutes: number;
  avgInsideMinutes: number;
  scheduledMinutesPerDay: number | null;
  measuredDays: number;
  days: { date: string; insideMinutes: number; spanMinutes: number }[];
}

export const workHoursApi = {
  daily: (date?: string) =>
    apiFetch<{
      success: boolean;
      date: string;
      isToday: boolean;
      settings: { presenceGapMin: number; sightingCreditMin: number };
      summary: { employees: number; present: number; inOfficeNow: number | null; totalInsideMinutes: number; avgInsideMinutes: number };
      data: WorkDayRow[];
    }>(`/work-hours/daily${date ? `?date=${date}` : ''}`),
  summary: (startDate: string, endDate: string) =>
    apiFetch<{
      success: boolean;
      startDate: string;
      endDate: string;
      dates: string[];
      settings: { presenceGapMin: number };
      data: WorkPeriodRow[];
    }>(`/work-hours/summary?startDate=${startDate}&endDate=${endDate}`),
};
