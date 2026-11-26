export const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000/api';

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

  if (res.status === 401 && typeof window !== 'undefined' && !endpoint.startsWith('/auth/login')) {
    setStoredToken(null);
    if (!window.location.pathname.startsWith('/login')) {
      window.location.href = '/login';
    }
  }
  // Signed in with a temporary password: everything else waits until a new one is chosen.
  if (res.status === 403 && data?.code === 'PASSWORD_CHANGE_REQUIRED' && typeof window !== 'undefined') {
    if (!window.location.pathname.startsWith('/change-password')) window.location.href = '/change-password';
  }

  if (!res.ok) {
    throw new Error(data.message || `HTTP error ${res.status}`);
  }

  return data;
}

export const api = {
  // Auth
  login: (email: string, password: string) =>
    apiFetch<{ success: boolean; token: string; user: SessionUser }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  logout: () =>
    apiFetch<{ success: boolean }>('/auth/logout', {
      method: 'POST',
    }),
  getMe: () =>
    apiFetch<{ success: boolean; user: SessionUser }>('/auth/me'),

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
        workSchedules: { id: string; name: string; startTime: string; endTime: string; graceMinutes?: number; workingDays?: string }[];
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
  enrollFace: (employeeId: string, image: Blob, source: 'UPLOAD' | 'WEBCAM' | 'MOBILE', angle: string = 'front') => {
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

  // Enrol from the office camera (live scanning; only full views are captured)
  scanLens: (cameraId: string, channelNo: number) =>
    apiFetch<{ success: boolean; data: LensScan }>(`/faces/scan/${cameraId}/${channelNo}`),
  scanCapture: (employeeId: string, req: { cameraId: string; channelNo: number; scanId: string; faceIndex: number }) =>
    apiFetch<ScanCaptureResult>(`/faces/${employeeId}/scan-capture`, { method: 'POST', body: JSON.stringify(req) }),
  scanSave: (employeeId: string, tokens: string[]) =>
    apiFetch<{ success: boolean; message: string; data: any }>(`/faces/${employeeId}/scan-save`, {
      method: 'POST',
      body: JSON.stringify({ tokens, consent: true }),
    }),

  // Phone self-enrolment via one-time QR link
  createMobileEnrollSession: (employeeId: string) =>
    apiFetch<{ success: boolean; data: MobileEnrollSessionCreated }>(`/faces/${employeeId}/mobile-session`, {
      method: 'POST',
    }),
  getMobileEnrollSession: (sessionId: string) =>
    apiFetch<{ success: boolean; data: MobileEnrollSession }>(`/faces/mobile-sessions/${sessionId}`),
  cancelMobileEnrollSession: (sessionId: string) =>
    apiFetch<{ success: boolean; data: MobileEnrollSession }>(`/faces/mobile-sessions/${sessionId}`, {
      method: 'DELETE',
    }),
  /** A photo the phone sent, waiting for HR to review (nothing is enrolled until HR saves). */
  getMobileEnrollPhoto: async (sessionId: string, angle: string): Promise<Blob> => {
    const res = await fetch(`${API_BASE}/faces/mobile-sessions/${sessionId}/photos/${angle}`, {
      headers: { Authorization: `Bearer ${getStoredToken() ?? ''}` },
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`Could not load the ${angle} photo from the phone`);
    return res.blob();
  },
  /** After HR saved the phone photos: discard the server's temporary copies. */
  completeMobileEnrollSession: (sessionId: string) =>
    apiFetch<{ success: boolean; data: MobileEnrollSession }>(`/faces/mobile-sessions/${sessionId}/complete`, {
      method: 'POST',
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

/** SUBMITTED = the phone sent its photos; they are not enrolled until HR saves them (COMPLETED). */
export type MobileEnrollStatus = 'PENDING' | 'OPENED' | 'SUBMITTED' | 'COMPLETED' | 'CANCELLED' | 'EXPIRED';

export interface MobileEnrollSession {
  sessionId: string;
  employeeId: string;
  status: MobileEnrollStatus;
  expiresAt: string;
  secondsRemaining: number;
  openedAt: string | null;
  completedAt: string | null;
  /** Angles the phone sent (SUBMITTED) / that HR saved (COMPLETED). */
  angles: string[];
}

export interface MobileEnrollSessionCreated extends MobileEnrollSession {
  token: string;
  /** Configured public URL (MOBILE_ENROLL_BASE_URL), e.g. an HTTPS domain or tunnel. */
  publicBaseUrl: string | null;
  /** This PC's Wi-Fi address, used when the dashboard is open on localhost. */
  lanIp: string | null;
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
  source: 'hls' | 'snapshot' | 'webcam' | 'file' | 'folder' | 'rtsp' | 'mjpeg' | 'http' | 'usb' | null;
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
  /** Recognition settings the AI service is using right now, and where they came from. */
  settings?: Record<string, number | string>;
  settingsSource?: 'dashboard' | '.env';
  settingsLoadedAt?: string | null;
}

// ---------------------------------------------------------------- settings

export type SettingsSectionName = 'ezviz' | 'recognition' | 'attendance' | 'enrollment';

export interface SettingsSection {
  /** Effective values. Secrets come back empty, with `<key>Set` telling whether one is saved. */
  values: Record<string, any>;
  defaults: Record<string, any>;
  /** Keys saved from the dashboard (the rest use their default). */
  customised: string[];
}

/** One face in a live lens scan. box = [x, y, w, h] as fractions of the picture. */
export interface ScanFace {
  index: number;
  box: [number, number, number, number];
  fullView: boolean;
  issues: { code: string; text: string }[];
  pose: 'FRONT' | 'LEFT' | 'RIGHT' | 'DOWN' | null;
  qualityScore: number;
  looksLike: { employeeId: string; name: string; similarity: number } | null;
}

export interface LensScan {
  scanId: string;
  cameraId: string;
  channelNo: number;
  width: number;
  height: number;
  /** data: URL of the (downscaled) picture the faces refer to */
  image: string;
  faces: ScanFace[];
  at: number;
}

export type ScanCaptureResult =
  | { success: boolean; status: 'ACCEPTED'; token: string; crop: string; pose: ScanFace['pose']; qualityScore: number; faceSizePx: number; ownSimilarity: number | null }
  | { success: boolean; status: 'OTHER_PERSON' | 'DUPLICATE' | 'NOT_FULL_VIEW' | 'EXPIRED' | 'LIMIT'; message: string };

export interface CameraLens {
  id: string;
  cameraId: string;
  channelNo: number;
  channelName: string;
  status: number;
  isEncrypted: boolean;
  recognitionEnabled: boolean;
  /** Non-EZVIZ cameras: where the video comes from, without the login. */
  streamUrl: string | null;
}

/** EZVIZ cloud | RTSP (IP camera / recorder) | HTTP (snapshot, MJPEG or HLS link) | USB. */
export type ConnectionType = 'EZVIZ' | 'RTSP' | 'HTTP' | 'USB';

export interface CameraRecord {
  id: string;
  name: string;
  model: string;
  serialNumber: string;
  provider: string;
  location: string | null;
  status: 'ONLINE' | 'OFFLINE' | 'ERROR' | 'MAINTENANCE';
  lastOnlineAt: string | null;
  firmwareVer: string | null;
  isEnabled: boolean;
  connectionType: ConnectionType;
  brand: string | null;
  host: string | null;
  port: number | null;
  username: string | null;
  /** A camera password is saved (it is never sent to the browser). */
  hasPassword: boolean;
  channels: CameraLens[];
}

export interface CameraBrand {
  id: string;
  label: string;
  port: number;
  username: string;
  multiChannel: boolean;
  /** "Other brand": the RTSP address has to be typed in. */
  needsUrl: boolean;
  hint: string;
}

export interface NetworkCamera {
  host: string;
  port: number;
  deviceUrl: string;
  name: string | null;
  hardware: string | null;
  manufacturer: string | null;
  isRecorder: boolean;
  cameraId: string | null;
  /** Name of an EZVIZ-cloud camera of the same model (probably this one, already added). */
  sameModelAs: string | null;
}

export interface OnvifStreams {
  device: { Manufacturer: string | null; Model: string | null; FirmwareVersion: string | null; SerialNumber: string | null };
  lenses: { channelNo: number; channelName: string; streamUrl: string; width: number; height: number; encoding: string | null }[];
}

export interface CameraTestResult {
  ok: boolean;
  message: string;
  width?: number;
  height?: number;
  /** data: URL of the picture. */
  image?: string;
  streamUrl?: string;
}

/** Details for testing or adding a non-EZVIZ camera. */
export interface CameraConnection {
  connectionType: ConnectionType;
  brand?: string;
  host?: string;
  port?: number | null;
  username?: string;
  password?: string;
  streamUrl?: string;
  channelNo?: number;
  channelCount?: number;
  channels?: { channelNo?: number; channelName?: string; streamUrl: string }[];
  cameraId?: string;
}

export interface DiscoveredCamera {
  serialNumber: string;
  name: string;
  model: string | null;
  firmware: string | null;
  online: boolean;
  channels: { channelNo: number; channelName: string; online: boolean }[];
  /** Set when this camera is already added to WorkSight. */
  cameraId: string | null;
}

export interface CameraChanges {
  name?: string;
  location?: string | null;
  isEnabled?: boolean;
  channels?: { channelNo: number; channelName?: string; recognitionEnabled?: boolean; streamUrl?: string }[];
  // Non-EZVIZ cameras
  host?: string;
  port?: number | null;
  username?: string | null;
  password?: string;
  passwordClear?: boolean;
  addChannels?: { channelNo?: number; channelName?: string; streamUrl?: string }[];
  removeChannels?: number[];
}

export interface WorkSchedule {
  id: string;
  officeId: string;
  name: string;
  startTime: string;
  endTime: string;
  graceMinutes: number;
  workingDays: string;
  employeeCount: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface WorkSchedulePayload {
  name: string;
  startTime: string;
  endTime: string;
  graceMinutes: number;
  workingDays: string;
}

export const settingsApi = {
  all: () =>
    apiFetch<{ success: boolean; canEdit: boolean; data: Record<SettingsSectionName, SettingsSection> }>('/settings'),
  save: (section: SettingsSectionName, changes: Record<string, any>) =>
    apiFetch<{ success: boolean; data: SettingsSection }>(`/settings/${section}`, {
      method: 'PUT',
      body: JSON.stringify(changes),
    }),
  testEzviz: (account: { appKey?: string; appSecret?: string; apiBaseUrl?: string }) =>
    apiFetch<{ success: boolean; data: { ok: boolean; message: string; deviceCount?: number | null } }>('/settings/ezviz/test', {
      method: 'POST',
      body: JSON.stringify(account),
    }),

  cameras: () => apiFetch<{ success: boolean; count: number; data: CameraRecord[] }>('/cameras'),
  discoverCameras: () => apiFetch<{ success: boolean; count: number; data: DiscoveredCamera[] }>('/cameras/discover'),
  addCamera: (body: Record<string, any>) =>
    apiFetch<{ success: boolean; data: CameraRecord }>('/cameras', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  brands: () => apiFetch<{ success: boolean; data: CameraBrand[] }>('/cameras/brands'),
  scanNetwork: () => apiFetch<{ success: boolean; count: number; data: NetworkCamera[] }>('/cameras/scan'),
  onvifStreams: (body: { host: string; port?: number; username: string; password: string; deviceUrl?: string }) =>
    apiFetch<{ success: boolean; data: OnvifStreams }>('/cameras/onvif', { method: 'POST', body: JSON.stringify(body) }),
  testCamera: (body: CameraConnection) =>
    apiFetch<{ success: boolean; data: CameraTestResult }>('/cameras/test', { method: 'POST', body: JSON.stringify(body) }),
  /** Current picture of a lens (works for every camera type). */
  cameraPreview: async (cameraId: string, channel: number): Promise<Blob> => {
    const token = getStoredToken();
    const res = await fetch(`${API_BASE}/cameras/${cameraId}/preview?channel=${channel}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      cache: 'no-store',
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.message || `HTTP error ${res.status}`);
    }
    return res.blob();
  },
  updateCamera: (id: string, changes: CameraChanges) =>
    apiFetch<{ success: boolean; data: CameraRecord }>(`/cameras/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(changes),
    }),
  removeCamera: (id: string) => apiFetch<{ success: boolean }>(`/cameras/${id}`, { method: 'DELETE' }),
  refreshCameras: () => apiFetch<{ success: boolean; message: string }>('/cameras/sync-ezviz', { method: 'POST' }),

  workSchedules: () =>
    apiFetch<{ success: boolean; canEdit: boolean; data: WorkSchedule[] }>('/work-schedules'),
  createWorkSchedule: (body: WorkSchedulePayload) =>
    apiFetch<{ success: boolean; data: WorkSchedule }>('/work-schedules', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateWorkSchedule: (id: string, body: Partial<WorkSchedulePayload>) =>
    apiFetch<{ success: boolean; data: WorkSchedule }>(`/work-schedules/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  deleteWorkSchedule: (id: string) =>
    apiFetch<{ success: boolean; message: string; unassignedEmployees: number }>(`/work-schedules/${id}`, {
      method: 'DELETE',
    }),
};

/** A stretch of continuous camera sightings (start/end are the first/last sighting). */
export interface WorkSession {
  start: string;
  end: string;
  seconds: number;
}

/** Not seen for longer than the away threshold: last sighting before -> first sighting after. */
export interface AwayPeriod {
  start: string;
  end: string;
  seconds: number;
}

export interface WorkDayRow {
  employee: { id: string; fullName: string; employeeCode: string; jobTitle?: string; department: string | null };
  scheduledMinutes: number | null;
  state: 'IN_OFFICE' | 'LEFT' | 'ABSENT';
  date: string | null;
  measured: boolean;
  checkIn: string | null;
  firstSeen: string | null;
  lastSeen: string | null;
  insideMinutes: number;
  insideSeconds: number;
  spanMinutes: number;
  awayMinutes: number;
  awaySeconds: number;
  sightings: number;
  isLate: boolean;
  /** Minutes after the scheduled start the employee was first seen (0 when on time). */
  lateByMinutes: number;
  longestAwaySeconds: number;
  /** Working hours on this date; startAt/endAt are UTC instants for placing on a timeline. */
  schedule: { name: string; start: string; end: string; graceMinutes: number; startAt: string; endAt: string } | null;
  sessions: WorkSession[];
  awayPeriods: AwayPeriod[];
}

export interface WorkPeriodDay {
  date: string;
  present: boolean;
  isLate: boolean;
  firstSeen: string | null;
  lastSeen: string | null;
  insideMinutes: number;
  awayMinutes: number;
  timesAway: number;
  spanMinutes: number;
}

export interface WorkPeriodRow {
  employee: { id: string; fullName: string; employeeCode: string; department: string | null };
  daysPresent: number;
  lateDays: number;
  totalInsideMinutes: number;
  totalAwayMinutes: number;
  totalSpanMinutes: number;
  avgInsideMinutes: number;
  scheduledMinutesPerDay: number | null;
  measuredDays: number;
  days: WorkPeriodDay[];
}

export interface Sighting {
  seenAt: string;
  action: 'CHECK_IN' | 'CHECK_OUT' | 'SEEN';
  similarity: number;
  channelNo: number;
  cameraName: string | null;
}

export interface WorkHoursSettings {
  presenceGapMin: number;
  defaultPresenceGapMin: number;
  sightingCreditMin: number;
  recognitionDedupSec: number;
}

const gapQs = (gapMin?: number) => (gapMin ? `gapMin=${gapMin}` : '');

export const workHoursApi = {
  daily: (date?: string, gapMin?: number) => {
    const qs = [date ? `date=${date}` : '', gapQs(gapMin)].filter(Boolean).join('&');
    return apiFetch<{
      success: boolean;
      date: string;
      today: string;
      isToday: boolean;
      settings: WorkHoursSettings;
      summary: { employees: number; present: number; inOfficeNow: number | null; totalInsideMinutes: number; avgInsideMinutes: number };
      data: WorkDayRow[];
    }>(`/work-hours/daily${qs ? `?${qs}` : ''}`);
  },
  summary: (startDate: string, endDate: string, gapMin?: number) =>
    apiFetch<{
      success: boolean;
      startDate: string;
      endDate: string;
      today: string;
      dates: string[];
      settings: WorkHoursSettings;
      data: WorkPeriodRow[];
    }>(`/work-hours/summary?startDate=${startDate}&endDate=${endDate}${gapMin ? `&${gapQs(gapMin)}` : ''}`),
  sightings: (employeeId: string, date?: string) =>
    apiFetch<{ success: boolean; date: string; count: number; data: Sighting[] }>(
      `/work-hours/${employeeId}/sightings${date ? `?date=${date}` : ''}`
    ),
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

// ---------------------------------------------------------------- accounts and access levels

/** What a signed-in person may do (decided by the server from their role). */
export type Permission = 'self.view' | 'reports.view' | 'cameras.live' | 'people.manage' | 'setup.manage' | 'users.manage';

export interface SessionUser {
  id: string;
  email: string;
  fullName: string;
  role: string;
  roleLabel: string;
  permissions: Permission[];
  mustChangePassword: boolean;
  /** The employee record this login belongs to ("My time"). */
  employee: { id: string; fullName: string; employeeCode: string } | null;
  company: { id: string; name: string } | null;
}

export const authApi = {
  changePassword: (currentPassword: string, newPassword: string) =>
    apiFetch<{ success: boolean; token: string; user: SessionUser }>('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
};

export interface UserAccount {
  id: string;
  email: string;
  fullName: string;
  role: string;
  roleLabel: string;
  isActive: boolean;
  isLocked: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  employee: { id: string; fullName: string; employeeCode: string } | null;
  isYou: boolean;
  /** False for a Super admin's account when you are not a Super admin. */
  canEdit: boolean;
}

export interface RoleInfo {
  value: string;
  label: string;
  description: string;
  permissions: Permission[];
  /** Whether you may give this access level. */
  assignable: boolean;
}

export interface AccountActivity {
  id: string;
  at: string;
  action: string;
  text: string;
  actor: string | null;
  target: string | null;
  changes: Record<string, [any, any]> | null;
}

export interface NewUser {
  fullName: string;
  email: string;
  role: string;
  employeeId?: string | null;
  password?: string;
}

export const usersApi = {
  list: () => apiFetch<{ success: boolean; count: number; data: UserAccount[] }>('/users'),
  roles: () => apiFetch<{ success: boolean; data: RoleInfo[] }>('/users/roles'),
  activity: (limit = 30) => apiFetch<{ success: boolean; data: AccountActivity[] }>(`/users/activity?limit=${limit}`),
  create: (body: NewUser) =>
    apiFetch<{ success: boolean; data: UserAccount; temporaryPassword: string }>('/users', { method: 'POST', body: JSON.stringify(body) }),
  update: (id: string, body: Partial<NewUser> & { isActive?: boolean; unlock?: boolean }) =>
    apiFetch<{ success: boolean; data: UserAccount }>(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  resetPassword: (id: string) =>
    apiFetch<{ success: boolean; data: UserAccount; temporaryPassword: string }>(`/users/${id}/reset-password`, { method: 'POST' }),
  remove: (id: string) => apiFetch<{ success: boolean }>(`/users/${id}`, { method: 'DELETE' }),
};

export interface MyDay {
  date: string;
  present: boolean;
  isLate: boolean;
  insideMinutes: number;
  awayMinutes: number;
  timesAway: number;
  firstSeen: string | null;
  lastSeen: string | null;
}

export interface MyOfficeTime {
  date: string;
  today: string;
  isToday: boolean;
  awayAfterMin: number;
  day: WorkDayRow;
  history: MyDay[];
  summary: { days: number; daysPresent: number; lateDays: number; totalInsideMinutes: number; avgInsideMinutes: number };
}

export const meApi = {
  officeTime: (date?: string, days = 14) =>
    apiFetch<{ success: boolean } & MyOfficeTime>(`/me/office-time?days=${days}${date ? `&date=${date}` : ''}`),
};

// ---------------------------------------------------------------- integrations (Settings > Integrations)

export interface ApiKeyInfo {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  isActive: boolean;
  createdByName?: string | null;
}

export interface WebhookInfo {
  id: string;
  url: string;
  description: string | null;
  events: string[];
  awayAfterMin: number;
  createdAt: string;
  createdBy: 'api' | 'dashboard';
  apiKeyName: string | null;
  isActive: boolean;
  lastDeliveryAt: string | null;
  lastStatus: 'OK' | 'FAILING' | null;
  lastError: string | null;
}

export interface WebhookDeliveryInfo {
  id: string;
  event: string;
  status: 'PENDING' | 'SENDING' | 'DELIVERED' | 'FAILED';
  attempts: number;
  createdAt: string;
  deliveredAt: string | null;
  nextAttemptAt: string | null;
  lastStatusCode: number | null;
  lastError: string | null;
  data: Record<string, unknown> | null;
}

export interface NewWebhook {
  url: string;
  events: string[];
  awayAfterMin: number;
  description?: string;
}

export const integrationsApi = {
  keys: () =>
    apiFetch<{ success: boolean; data: ApiKeyInfo[]; scopes: { scope: string; description: string }[]; docsPath: string }>(
      '/integrations/keys',
    ),
  createKey: (name: string, scopes: string[]) =>
    apiFetch<{ success: boolean; data: ApiKeyInfo & { key: string } }>('/integrations/keys', {
      method: 'POST',
      body: JSON.stringify({ name, scopes }),
    }),
  revokeKey: (id: string) => apiFetch<{ success: boolean; data: ApiKeyInfo }>(`/integrations/keys/${id}`, { method: 'DELETE' }),
  webhooks: () =>
    apiFetch<{ success: boolean; data: WebhookInfo[]; events: { event: string; description: string }[] }>('/integrations/webhooks'),
  createWebhook: (body: NewWebhook) =>
    apiFetch<{ success: boolean; data: WebhookInfo & { secret: string } }>('/integrations/webhooks', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  removeWebhook: (id: string) => apiFetch<{ success: boolean }>(`/integrations/webhooks/${id}`, { method: 'DELETE' }),
  testWebhook: (id: string) =>
    apiFetch<{ success: boolean; data: WebhookDeliveryInfo }>(`/integrations/webhooks/${id}/test`, { method: 'POST' }),
  deliveries: (id: string) =>
    apiFetch<{ success: boolean; data: WebhookDeliveryInfo[] }>(`/integrations/webhooks/${id}/deliveries`),
};
