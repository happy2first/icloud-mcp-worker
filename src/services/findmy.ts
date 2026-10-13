// HTTP/state handling ported from timlaing/pyicloud findmyiphone.py.
// No background monitor; serverContext and locations live only in this request.
import { z } from "zod";
import { AppError } from "../errors.ts";
import { WebClient, webOperation } from "./web.ts";
import type { RuntimeEnv } from "../platform/sites.ts";

const object = z.record(z.unknown());
const deviceSchema = object.and(z.object({ id: z.string().min(1) }));
const envelope = z
  .object({
    serverContext: object,
    userInfo: z
      .object({
        hasMembers: z.boolean().optional(),
        firstName: z.string().optional(),
        lastName: z.string().optional(),
        membersInfo: z.record(object).optional(),
      })
      .passthrough()
      .optional(),
    content: z.array(deviceSchema).optional(),
  })
  .passthrough();
type Device = z.infer<typeof deviceSchema>;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) => (typeof value === "string" ? value : null);
const finite = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const name = (v: Record<string, unknown>) =>
  [text(v.firstName), text(v.lastName)].filter(Boolean).join(" ") || null;

export class FindMyClient {
  private context: Record<string, unknown> | null = null;
  private info: Record<string, unknown> = {};
  private devices = new Map<string, Device>();
  private deadline: number;
  constructor(
    readonly web: Pick<WebClient, "request">,
    readonly pause = (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms)),
    readonly now = Date.now,
  ) {
    this.deadline = now() + 18_000;
  }
  private async refresh(selectedDevice?: string) {
    const clientContext: Record<string, unknown> = {
      appName: "iCloud Find (Web)",
      appVersion: "2.0",
      apiVersion: "3.0",
      deviceListVersion: 1,
      fmly: true,
      timezone: "US/Pacific",
      inactiveTime: 0,
    };
    const payload: Record<string, unknown> = { clientContext };
    if (this.context) {
      payload.serverContext = this.context;
      if (selectedDevice) {
        clientContext.shouldLocate = true;
        clientContext.selectedDevice = selectedDevice;
      }
    }
    const response = await this.web.request(
      "fmip",
      `/fmipservice/client/web/${this.context ? "refreshClient" : "initClient"}`,
      payload,
    );
    const parsed = envelope.safeParse(response);
    if (!parsed.success)
      throw new AppError(
        "PROTOCOL_CHANGED",
        "Find My returned an unsupported device envelope. Check project updates.",
      );
    this.context = { ...parsed.data.serverContext };
    if ("theftLoss" in this.context) this.context.theftLoss = null;
    if (parsed.data.userInfo) this.info = parsed.data.userInfo;
    for (const device of parsed.data.content ?? [])
      this.devices.set(device.id, device);
  }
  private members() {
    return Object.entries(record(this.info.membersInfo)).map(([id, value]) => {
      const member = record(value);
      return {
        id,
        name: name(member),
        deviceFetchStatus: text(member.deviceFetchStatus) ?? "UNKNOWN",
      };
    });
  }
  private metadata() {
    const members = this.members();
    const familyComplete =
      this.info.hasMembers === false ||
      (this.info.membersInfo !== undefined &&
        members.every((m) => m.deviceFetchStatus === "DONE"));
    return {
      members,
      familyLoading: members.some((m) => m.deviceFetchStatus === "LOADING"),
      familyComplete,
      familyNotice: !familyComplete
        ? "Some family devices are still loading or unavailable. Retry later; LOADING alone does not prove permission denial."
        : null,
    };
  }
  private async initialize() {
    await this.refresh();
    let previous = "";
    for (
      let retry = 0;
      retry < 5 && this.now() + 1000 < this.deadline;
      retry++
    ) {
      const loading = this.members()
        .filter((m) => m.deviceFetchStatus === "LOADING")
        .map((m) => m.id)
        .sort()
        .join(",");
      if (!loading || loading === previous) break;
      previous = loading;
      await this.pause(500);
      await this.refresh();
    }
  }
  private target(id: string) {
    const device = this.devices.get(id);
    if (!device)
      throw new AppError(
        "CONFLICT",
        this.metadata().familyLoading
          ? "Device was not returned while family devices are loading. Retry the listing; no action was sent."
          : "Device is not accessible to this Apple account. Refresh the device listing; no action was sent.",
        409,
      );
    return device;
  }
  private summary(d: Device) {
    const prsId = text(d.prsId);
    const self = !prsId || prsId === text(this.context?.prsId);
    const member = prsId
      ? record(record(this.info.membersInfo)[prsId])
      : this.info;
    const rawStatus = String(d.deviceStatus ?? "");
    const battery = finite(d.batteryLevel);
    return {
      id: d.id,
      name: text(d.name),
      type: text(d.deviceClass),
      model: text(d.deviceDisplayName) ?? text(d.deviceModel),
      owner: { id: prsId, name: name(self ? this.info : member), isSelf: self },
      online:
        rawStatus === "200"
          ? true
          : ["201", "203"].includes(rawStatus)
            ? false
            : null,
      deviceStatus: rawStatus || null,
      batteryLevel:
        battery !== null && battery >= 0 && battery <= 1 ? battery : null,
      locationAllowed:
        record(d.features).LOC === false || d.locationEnabled === false
          ? false
          : null,
      soundAvailable: record(d.features).SND === true,
    };
  }
  private location(d: Device) {
    if (record(d.features).LOC !== true || d.locationEnabled === false)
      return null;
    const l = record(d.location);
    const latitude = finite(l.latitude),
      longitude = finite(l.longitude),
      timestamp = finite(l.timeStamp);
    if (
      latitude === null ||
      longitude === null ||
      Math.abs(latitude) > 90 ||
      Math.abs(longitude) > 180
    )
      return null;
    return {
      latitude,
      longitude,
      horizontalAccuracy: finite(l.horizontalAccuracy),
      timestamp:
        timestamp !== null && timestamp >= 0 && timestamp <= 8640000000000000
          ? timestamp
          : null,
      time:
        timestamp !== null && timestamp >= 0 && timestamp <= 8640000000000000
          ? new Date(timestamp).toISOString()
          : null,
      isOld: typeof l.isOld === "boolean" ? l.isOld : null,
      ageSeconds:
        timestamp !== null
          ? Math.max(0, (this.now() - timestamp) / 1000)
          : null,
      positionType: text(l.positionType),
    };
  }
  async list() {
    await this.initialize();
    return {
      devices: [...this.devices.values()].map((d) => this.summary(d)),
      ...this.metadata(),
    };
  }
  async getLocation(id: string, refresh = true) {
    await this.initialize();
    const before = this.location(this.target(id));
    const requestedAt = this.now();
    let refreshAccepted = false,
      newLocationObtained = false;
    if (refresh && this.summary(this.target(id)).locationAllowed !== false) {
      for (
        let retry = 0;
        retry < 3 && this.now() + 1000 < this.deadline;
        retry++
      ) {
        if (retry) await this.pause(500);
        await this.refresh(id);
        refreshAccepted = true;
        const fix = this.location(this.target(id));
        newLocationObtained =
          !!fix &&
          fix.isOld === false &&
          fix.timestamp !== null &&
          fix.timestamp > (before?.timestamp ?? 0) &&
          fix.timestamp >= requestedAt;
        if (
          newLocationObtained ||
          this.summary(this.target(id)).online === false
        )
          break;
      }
    }
    const device = this.target(id),
      summary = this.summary(device),
      location = this.location(device);
    const status =
      summary.locationAllowed === false
        ? "NO_LOCATION_PERMISSION"
        : !refresh
          ? location
            ? "LAST_REPORTED_LOCATION"
            : "LOCATION_UNAVAILABLE"
          : newLocationObtained
            ? "NEW_LOCATION"
            : summary.online === false
              ? "DEVICE_OFFLINE"
              : refreshAccepted
                ? "LOCATION_TIMEOUT"
                : "LOCATION_UNAVAILABLE";
    return {
      device: summary,
      location,
      status,
      refreshRequested: refresh,
      refreshAccepted,
      newLocationObtained,
      requestedAt: refresh ? requestedAt : null,
      message:
        status === "LOCATION_TIMEOUT"
          ? "Apple accepted refresh but no demonstrably new fix arrived within this bounded request. Returned location may be historical; retry later."
          : null,
      ...this.metadata(),
    };
  }
  async playSound(id: string, confirmed: boolean) {
    if (confirmed !== true)
      throw new AppError(
        "VALIDATION_ERROR",
        "Obtain explicit user confirmation for this device before playing a sound.",
      );
    await this.initialize();
    const device = this.target(id);
    if (record(device.features).SND !== true)
      throw new AppError(
        "UNSUPPORTED_FEATURE",
        "Apple does not permit playing sound on this device.",
        409,
      );
    // Do not replay an active operation after any ambiguous transport failure.
    let response: unknown;
    try {
      response = await this.web.request(
        "fmip",
        "/fmipservice/client/web/playSound",
        {
          device: id,
          subject: "Find My iPhone Alert",
          clientContext: { fmly: true },
        },
      );
    } catch (error) {
      if (
        error instanceof AppError &&
        [
          "REAUTH_REQUIRED",
          "VERIFICATION_REQUIRED",
          "FORBIDDEN",
          "RATE_LIMITED",
        ].includes(error.code)
      )
        throw error;
      throw new AppError(
        "WRITE_OUTCOME_UNKNOWN",
        "Find My sound may have been queued. Do not automatically retry; ask the user to check the device.",
        503,
      );
    }
    const sound = record(record(response).snd);
    const code = record(response).statusCode ?? sound.statusCode;
    if (code !== undefined && !["200", "203"].includes(String(code)))
      throw new AppError(
        "PROTOCOL_CHANGED",
        "Apple did not confirm the sound request. Check device status before another explicitly confirmed attempt.",
      );
    return {
      deviceId: id,
      requestAccepted: true,
      playbackConfirmed: false,
      message:
        "Apple accepted the sound request; actual playback is not verified and may be delayed when offline.",
    };
  }
}
export async function findMyOperation<T>(
  env: RuntimeEnv,
  owner: string,
  run: (client: FindMyClient) => Promise<T>,
  replaySafe = true,
) {
  try {
    return await webOperation(
      env,
      owner,
      "fmip",
      (web) => run(new FindMyClient(web)),
      false,
      replaySafe,
    );
  } catch (error) {
    if (
      !replaySafe &&
      (!(error instanceof AppError) || error.code === "UPSTREAM_UNAVAILABLE")
    )
      throw new AppError(
        "WRITE_OUTCOME_UNKNOWN",
        "Find My sound outcome is uncertain. Do not automatically retry; check the device and obtain a new user confirmation.",
        503,
      );
    throw error;
  }
}
