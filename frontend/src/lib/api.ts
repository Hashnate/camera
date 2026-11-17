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

  if (res.status === 401 && typeof window !== 'undefined') {
    setStoredToken(null);
    if (!window.location.pathname.startsWith('/login')) {
      window.location.href = '/login';
    }
  }

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
  updateEmployee: (id: string, payload: any) =>
    apiFetch<{ success: boolean; data: any }>(`/employees/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  deleteEmployee: (id: string) =>
    apiFetch<{ success: boolean; message: string }>(`/employees/${id}`, {
      method: 'DELETE',
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
  getFaceDetails: (employeeId: string) =>
    apiFetch<{
      success: boolean;
      employeeId: string;
      fullName: string;
      samples: number;
      angles: Record<string, { captured: boolean; previewUrl: string | null; status: string; qualityScore?: number }>;
    }>(`/faces/${employeeId}/details`),
  validateFace: (image: Blob, expectedAngle?: string) => {
    const form = new FormData();
    form.append('image', image, 'validate.jpg');
    if (expectedAngle) {
      form.append('expected_angle', expectedAngle);
    }
    return apiFetch<{
      success: boolean;
      data: {
        valid: boolean;
        status: string;
        message: string;
        detectedAngle?: string;
        angleMatch?: boolean;
        confidence?: number;
        qualityScore?: number;
        lighting?: string;
        sharpness?: string;
        quality?: { brightness: number; sharpness: number };
      };
    }>('/faces/validate', {
      method: 'POST',
      body: form,
    });
  },
  enrollFace: (employeeId: string, image: Blob, source: 'UPLOAD' | 'WEBCAM', angle: string = 'front') => {
    const form = new FormData();
    form.append('image', image, `${angle}.jpg`);
    form.append('consent', 'true');
    form.append('source', source);
    form.append('angle', angle);
    return apiFetch<{ success: boolean; message: string; previewUrl?: string; data: any }>(`/faces/${employeeId}`, {
      method: 'POST',
      body: form,
    });
  },
  revokeFace: (employeeId: string) =>
    apiFetch<{ success: boolean; message: string; deleted: number }>(`/faces/${employeeId}`, {
      method: 'DELETE',
    }),

  // System A: Real-Time Presence
  getPresenceOverview: () =>
    apiFetch<{ success: boolean; data: any[] }>('/presence/overview'),
  getPresenceObservations: (limit = 30) =>
    apiFetch<{ success: boolean; data: any[] }>(`/presence/observations?limit=${limit}`),

  // System B: Hybrid Work Sessions & Exception Reviews
  getMyTodaySession: () =>
    apiFetch<{ success: boolean; data: any }>('/attendance/me/today'),
  getAttendanceReviews: (status?: string) =>
    apiFetch<{ success: boolean; data: any[] }>(`/attendance/reviews${status ? `?status=${status}` : ''}`),
  resolveAttendanceReview: (reviewId: string, resolution: string) =>
    apiFetch<{ success: boolean; data: any }>(`/attendance/reviews/${reviewId}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ resolution }),
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

  // Zone Configuration & Office Tracking
  getZones: () =>
    apiFetch<{ success: boolean; count: number; data: CameraZone[] }>('/zones'),
  getCameraZoneConfig: (cameraId: string, channel: number = 1) =>
    apiFetch<{ success: boolean; data: ZoneConfigResponse }>(`/cameras/${cameraId}/zone-config?channel=${channel}`),
  updateCameraZoneConfig: (cameraId: string, channel: number = 1, config: { zones: any[]; lines: any[] }) =>
    apiFetch<{ success: boolean; data: any }>(`/cameras/${cameraId}/zone-config?channel=${channel}`, {
      method: 'PUT',
      body: JSON.stringify(config),
    }),
  getActiveTracks: (cameraId?: string, channelNo?: number) => {
    const params = new URLSearchParams();
    if (cameraId) params.set('camera_id', cameraId);
    if (channelNo !== undefined) params.set('channel_no', String(channelNo));
    const qs = params.toString();
    return apiFetch<ActiveTrackResponse>(`/tracking/active${qs ? `?${qs}` : ''}`);
  },
  getZoneTransitions: (limit = 50) =>
    apiFetch<{ success: boolean; count: number; data: ZoneTransition[] }>(`/tracking/zone-transitions?limit=${limit}`),
  getEmployeeZoneTimeline: (employeeId: string, limit = 30) =>
    apiFetch<{ success: boolean; data: any[] }>(`/tracking/employee/${employeeId}/timeline?limit=${limit}`),

  // WorkSight v2.3 Daily Employee Tracking APIs
  getDailyTracking: (date?: string) => dailyTrackingApi.getDaily(date),
  getDailyTrackingLive: () => dailyTrackingApi.getLive(),
  getDailyTrackingSummary: (date?: string) => dailyTrackingApi.getSummary(date),
  getDailyTrackingReport: (date?: string) => dailyTrackingApi.getReport(date),
  getDailyEmployeeDetail: (employeeId: string, date?: string) => dailyTrackingApi.getEmployeeDetail(employeeId, date),
  getDailyEmployeeTimeline: (employeeId: string, date?: string) => dailyTrackingApi.getEmployeeTimeline(employeeId, date),
  getDailyEmployeeZones: (employeeId: string, date?: string) => dailyTrackingApi.getEmployeeZones(employeeId, date),
  correctZoneInterval: (employeeId: string, payload: { intervalId: string; newZoneId: string; reason: string }) =>
    dailyTrackingApi.correctInterval(employeeId, payload),
  getDailyEmployeeCalculation: (employeeId: string, date?: string) =>
    dailyTrackingApi.getEmployeeCalculation(employeeId, date),
  getDailyEmployeeIntervals: (employeeId: string, date?: string) =>
    dailyTrackingApi.getEmployeeIntervals(employeeId, date),
  closeDailyTrackingSession: (
    employeeId: string,
    payload: { workDate?: string; reason?: string; sessionStatus?: string }
  ) => dailyTrackingApi.closeSession(employeeId, payload),

  // WorkSight v2.8 Movement-Based Break & Away-Time APIs
  getLiveBreaks: (date?: string) => breaksApi.getLive(date),
  getBreakPolicies: () => breaksApi.getPolicies(),
  upsertBreakPolicy: (payload: Partial<BreakPolicyItem>) => breaksApi.upsertPolicy(payload),
  deleteBreakPolicy: (policyId: string) => breaksApi.deletePolicy(policyId),
  getBreakHistory: (date?: string, employeeId?: string) => breaksApi.getHistory(date, employeeId),
  deleteBreakInterval: (intervalId: string) => breaksApi.deleteInterval(intervalId),
  endOngoingBreak: (intervalId: string) => breaksApi.endOngoingBreak(intervalId),
  declareBreak: (payload: { employee_id: string; break_type: string; duration_minutes: number; started_at?: string; notes?: string }) =>
    breaksApi.declareBreak(payload),
  correctBreakInterval: (intervalId: string, payload: { new_duration_seconds?: number; new_classification?: string; reason: string }) =>
    breaksApi.correctInterval(intervalId, payload),
  getBreakReconciliation: (date?: string, employeeId?: string) => breaksApi.getReconciliation(date, employeeId),
};

export interface CameraZone {
  id: string;
  cameraId: string;
  channelNo: number;
  zoneId: string;
  zoneName: string;
  normalizedPolygon: [number, number][];
  enabled: boolean;
  configurationVersion: number;
}

export interface DoorCrossingLine {
  id: string;
  cameraId: string;
  channelNo: number;
  lineId: string;
  lineName: string;
  normalizedStartPoint: [number, number];
  normalizedEndPoint: [number, number];
  directionMapping: {
    forward: { event: string; from: string; to: string };
    backward: { event: string; from: string; to: string };
  };
  enabled: boolean;
}

export interface ZoneConfigResponse {
  cameraId: string;
  channelNo: number;
  zones: CameraZone[];
  lines: DoorCrossingLine[];
}

export interface ActiveTrackResponse {
  success: boolean;
  count: number;
  cameraId?: string;
  channelNo?: number;
  frameId?: number;
  frameTimestamp?: string;
  processingTimestamp?: string;
  cameraConnectionStatus?: string;
  metrics: {
    detectedPeople: number;
    activeTracks: number;
    verifiedTracks: number;
    unidentifiedTracks: number;
    fps: number;
  };
  data: ActiveTrack[];
}

export interface ActiveTrack {
  id: string;
  cameraId: string;
  channelNo: number;
  trackId: number;
  employeeId: string | null;
  employeeName: string;
  employeeCode: string | null;
  startedAt: string;
  lastSeenAt: string;
  identityVerificationStatus: string;
  currentZoneId: string;
  boundingBox?: [number, number, number, number];
  detectionScore?: number;
  freshnessSec?: number;
}

export interface ZoneTransition {
  id: string;
  employeeId: string | null;
  employeeName: string;
  employeeCode: string | null;
  crossingLineId: string;
  fromZoneId: string;
  toZoneId: string;
  eventType: string;
  observedAt: string;
  verificationStatus: string;
  channelNo: number;
}


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

// ------------------------------------------------------------- WorkSight v2.3 Daily Tracking Types & API

export interface DailyEmployeeDurations {
  workRoomSeconds: number;
  workRoomFormatted: string;
  lunchRoomSeconds: number;
  lunchRoomFormatted: string;
  outsideOfficeSeconds: number;
  outsideOfficeFormatted: string;
  passageSeconds: number;
  passageFormatted: string;
  unknownSeconds: number;
  unknownFormatted: string;
  totalObservedSeconds: number;
  totalObservedFormatted: string;
  officialAttendanceSeconds: number;
  officialAttendanceFormatted: string;
  currentObservationStatus: 'OBSERVED_RECENTLY' | 'NOT_RECENTLY_OBSERVED' | 'SENSOR_UNAVAILABLE';
  secondsSinceLastSeen: number;
}

export interface DailyTrackingItem {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  departmentName: string;
  jobTitle: string;
  workDate: string;
  hasTrackingSession: boolean;
  dailySessionId?: string;
  sessionStatus: 'ACTIVE' | 'PAUSED' | 'CLOSED' | 'REQUIRES_REVIEW' | 'NOT_STARTED';
  currentZoneId: 'WORK_ROOM' | 'LUNCH_ROOM' | 'PASSAGE' | 'OUTSIDE' | 'UNKNOWN';
  currentObservationStatus: 'OBSERVED_RECENTLY' | 'NOT_RECENTLY_OBSERVED' | 'SENSOR_UNAVAILABLE';
  firstObservedAt: string | null;
  lastObservedAt: string | null;
  attendanceCheckInAt: string | null;
  attendanceCheckOutAt: string | null;
  attendanceStatus: string;
  durations: DailyEmployeeDurations;
}

export interface DailyTrackingSummary {
  totalEmployees: number;
  totalTrackedEmployees: number;
  currentlyInWorkingRoom: number;
  currentlyInLunchRoom: number;
  currentlyInPassage: number;
  currentlyOutside: number;
  currentlyUnknown: number;
  totalWorkingRoomSeconds: number;
  totalWorkingRoomFormatted: string;
  totalLunchRoomSeconds: number;
  totalLunchRoomFormatted: string;
  totalAttendanceSeconds: number;
  totalAttendanceFormatted: string;
  averageWorkingRoomPerEmployee: string;
}

export interface DailyEmployeeDetail {
  success: boolean;
  employee: {
    id: string;
    code: string;
    name: string;
    department: string;
    jobTitle: string;
    assignedZone?: string;
  };
  workDate: string;
  hasTrackingSession: boolean;
  dailySessionId?: string;
  sessionStatus?: string;
  currentZoneId?: string;
  currentObservationStatus?: string;
  firstObservedAt?: string;
  lastObservedAt?: string;
  attendanceCheckInAt?: string;
  attendanceCheckOutAt?: string;
  durations: DailyEmployeeDurations;
  intervals: {
    id: string;
    zoneId: string;
    enteredAt: string;
    exitedAt: string | null;
    durationSeconds: number;
    durationFormatted: string;
    verificationStatus: string;
    sourceCameraId?: string;
    isOngoing: boolean;
  }[];
  timeline: {
    id: string;
    eventType: string;
    fromZoneId: string;
    toZoneId: string;
    crossingLineId?: string;
    timestamp: string;
    verificationConfidence: number;
    cameraTrackId?: number;
    sourceCameraId?: string;
    sourceChannelNo?: number;
  }[];
}

export interface DailyTrackingReport {
  success: boolean;
  date: string;
  generatedAt: string;
  employeeCount: number;
  exceptionsCount: number;
  exceptions: {
    employeeId: string;
    employeeName: string;
    issue: string;
    details: string;
  }[];
  records: any[];
}

export const dailyTrackingApi = {
  getDaily: (date?: string) =>
    apiFetch<{ success: boolean; date: string; count: number; data: DailyTrackingItem[] }>(
      `/tracking/daily${date ? `?date=${date}` : ''}`
    ),
  getLive: () =>
    apiFetch<{ success: boolean; date: string; timestamp: string; count: number; data: DailyTrackingItem[] }>(
      '/tracking/daily/live'
    ),
  getSummary: (date?: string) =>
    apiFetch<{ success: boolean; date: string; summary: DailyTrackingSummary }>(
      `/tracking/daily/summary${date ? `?date=${date}` : ''}`
    ),
  getReport: (date?: string) =>
    apiFetch<DailyTrackingReport>(`/tracking/daily/report${date ? `?date=${date}` : ''}`),
  getEmployeeDetail: (employeeId: string, date?: string) =>
    apiFetch<DailyEmployeeDetail>(`/tracking/daily/${employeeId}${date ? `?date=${date}` : ''}`),
  getEmployeeTimeline: (employeeId: string, date?: string) =>
    apiFetch<{ success: boolean; employeeId: string; date: string; timeline: any[]; intervals: any[] }>(
      `/tracking/daily/${employeeId}/timeline${date ? `?date=${date}` : ''}`
    ),
  getEmployeeZones: (employeeId: string, date?: string) =>
    apiFetch<{ success: boolean; employeeId: string; date: string; durations: DailyEmployeeDurations; intervals: any[] }>(
      `/tracking/daily/${employeeId}/zones${date ? `?date=${date}` : ''}`
    ),
  correctInterval: (employeeId: string, payload: { intervalId: string; newZoneId: string; reason: string }) =>
    apiFetch<{ success: boolean; message: string; intervalId: string; zoneId: string }>(
      `/tracking/daily/${employeeId}/correct`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    ),
  getEmployeeCalculation: (employeeId: string, date?: string) =>
    apiFetch<{
      success: boolean;
      employeeId: string;
      employeeName: string;
      employeeCode?: string;
      workDate: string;
      sessionStatus: string;
      zoneDurations: {
        workRoomSeconds: number;
        workRoomFormatted: string;
        lunchRoomSeconds: number;
        lunchRoomFormatted: string;
        passageSeconds: number;
        passageFormatted: string;
        outsideOfficeSeconds: number;
        outsideOfficeFormatted: string;
        unknownSeconds: number;
        unknownFormatted: string;
        totalObservedSeconds: number;
        totalObservedFormatted: string;
      };
      breakClassifications: {
        approvedPaidBreakSeconds: number;
        approvedPaidBreakFormatted: string;
        approvedUnpaidBreakSeconds: number;
        approvedUnpaidBreakFormatted: string;
        excessBreakSeconds: number;
        excessBreakFormatted: string;
        unplannedAwaySeconds: number;
        unplannedAwayFormatted: string;
      };
      officialAttendance: {
        officialAttendanceSeconds: number;
        officialAttendanceFormatted: string;
        attendanceStatus: string;
        checkInAt?: string;
        checkOutAt?: string;
      };
      isReconciled: boolean;
      reconciliationDifferenceSeconds: number;
    }>(`/tracking/daily/${employeeId}/calculation${date ? `?date=${date}` : ''}`),
  getEmployeeIntervals: (employeeId: string, date?: string) =>
    apiFetch<{
      success: boolean;
      employeeId: string;
      employeeName: string;
      employeeCode?: string;
      workDate: string;
      count: number;
      intervals: any[];
    }>(`/tracking/daily/${employeeId}/intervals${date ? `?date=${date}` : ''}`),
  closeSession: (
    employeeId: string,
    payload: { workDate?: string; reason?: string; sessionStatus?: string }
  ) =>
    apiFetch<{ success: boolean; message: string; sessionId: string; sessionStatus: string }>(
      `/tracking/daily/${employeeId}/close`,
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    ),
};

// ------------------------------------------------------------- WorkSight v2.8 Movement-Based Break & Away-Time Engine

export interface LiveBreakEmployee {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  departmentName: string;
  jobTitle: string;
  workDate: string;
  hasTrackingSession: boolean;
  currentZoneId: string;
  currentObservationStatus: string;
  secondsSinceLastSeen?: number;
  activeBreak: {
    id: string;
    breakType: string;
    startedAt: string;
    elapsedSeconds: number;
    elapsedFormatted: string;
    allowedDurationMinutes: number;
    remainingSeconds: number;
    remainingFormatted: string;
    isExceeded: boolean;
    excessSeconds: number;
    excessFormatted: string;
    isPaid: boolean;
    classification: string;
    source: string;
  } | null;
  todayBreaksSummary: {
    lunchApprovedSeconds: number;
    lunchApprovedFormatted: string;
    lunchExcessSeconds: number;
    lunchExcessFormatted: string;
    prayerSeconds: number;
    prayerFormatted: string;
    teaSeconds: number;
    teaFormatted: string;
    outsideSeconds: number;
    outsideFormatted: string;
    totalBreakSeconds: number;
    totalBreakFormatted: string;
  };
  lastMovement: {
    eventType: string;
    fromZoneId?: string;
    toZoneId?: string;
    timestamp: string;
    sourceCameraId?: string;
    sourceChannelNo?: number;
  } | null;
  serverTimestamp: string;
}

export interface BreakPolicyItem {
  id: string;
  companyId: string;
  employeeId: string | null;
  breakType: string;
  name: string;
  allowedDurationMinutes: number;
  isPaid: boolean;
  maxCountPerDay: number;
  effectiveFrom: string | null;
  isActive: boolean;
  notes?: string;
}

export interface BreakIntervalItem {
  id: string;
  employeeId: string;
  employeeName: string;
  employeeCode: string;
  breakType: string;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number;
  durationFormatted: string;
  allowedDurationMinutes: number;
  excessDurationSeconds: number;
  excessDurationFormatted: string;
  classification: string;
  isPaid: boolean;
  source: string;
  notes?: string;
  isOngoing: boolean;
}

export interface BreakReconciliationItem {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  departmentName: string;
  workDate: string;
  hasTrackingSession: boolean;
  officialAttendanceSeconds: number;
  officialAttendanceFormatted: string;
  workRoomSeconds: number;
  workRoomFormatted: string;
  lunchApprovedSeconds: number;
  lunchApprovedFormatted: string;
  lunchExcessSeconds: number;
  lunchExcessFormatted: string;
  prayerSeconds: number;
  prayerFormatted: string;
  teaSeconds: number;
  teaFormatted: string;
  otherApprovedSeconds: number;
  otherApprovedFormatted: string;
  outsideOfficeSeconds: number;
  outsideOfficeFormatted: string;
  unplannedAwaySeconds: number;
  unplannedAwayFormatted: string;
  unknownSeconds: number;
  unknownFormatted: string;
  passageSeconds?: number;
  passageFormatted?: string;
  totalObservedSeconds: number;
  totalObservedFormatted: string;
  netProductiveSeconds: number;
  netProductiveFormatted: string;
  totalDeductibleSeconds: number;
  totalDeductibleFormatted: string;
  zeroDoubleCountingVerified: boolean;
}

export const breaksApi = {
  getLive: (date?: string) =>
    apiFetch<{ success: boolean; date: string; count: number; data: LiveBreakEmployee[] }>(
      `/breaks/live${date ? `?date=${date}` : ''}`
    ),
  getPolicies: () =>
    apiFetch<{ success: boolean; count: number; data: BreakPolicyItem[] }>('/breaks/policies'),
  upsertPolicy: (payload: Partial<BreakPolicyItem>) =>
    apiFetch<{ success: boolean; message: string; data: any }>('/breaks/policies', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  deletePolicy: (policyId: string) =>
    apiFetch<{ success: boolean; message: string; id: string }>(`/breaks/policies/${policyId}`, {
      method: 'DELETE',
    }),
  restoreDefaults: () =>
    apiFetch<{ success: boolean; message: string; count: number }>('/breaks/policies/restore-defaults', {
      method: 'POST',
    }),
  getHistory: (date?: string, employeeId?: string) => {
    const params = new URLSearchParams();
    if (date) params.set('date', date);
    if (employeeId) params.set('employee_id', employeeId);
    const qs = params.toString();
    return apiFetch<{ success: boolean; date: string; count: number; data: BreakIntervalItem[] }>(
      `/breaks/history${qs ? `?${qs}` : ''}`
    );
  },
  deleteInterval: (intervalId: string) =>
    apiFetch<{ success: boolean; message: string; id: string }>(`/breaks/intervals/${intervalId}`, {
      method: 'DELETE',
    }),
  endOngoingBreak: (intervalId: string) =>
    apiFetch<{ success: boolean; message: string; data: any }>(`/breaks/intervals/${intervalId}/end`, {
      method: 'POST',
    }),
  declareBreak: (payload: {
    employee_id: string;
    break_type: string;
    duration_minutes: number;
    started_at?: string;
    notes?: string;
  }) =>
    apiFetch<{ success: boolean; message: string; data: any }>('/breaks/declare', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  correctInterval: (
    intervalId: string,
    payload: { new_duration_seconds?: number; new_classification?: string; reason: string }
  ) =>
    apiFetch<{ success: boolean; message: string; data: any }>(`/breaks/intervals/${intervalId}/correct`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  getReconciliation: (date?: string, employeeId?: string) => {
    const params = new URLSearchParams();
    if (date) params.set('date', date);
    if (employeeId) params.set('employee_id', employeeId);
    const qs = params.toString();
    return apiFetch<{ success: boolean; date: string; count: number; data: BreakReconciliationItem[] }>(
      `/breaks/reconciliation${qs ? `?${qs}` : ''}`
    );
  },
};
