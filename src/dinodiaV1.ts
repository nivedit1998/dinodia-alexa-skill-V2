import { createHash } from 'node:crypto';

export interface NativeControlV1 { schemaVersion: number; deviceId: string; surfaceId?: string|null; controlId: string; label: string; group?: string|null; valueType: 'boolean'|'number'|'option'|'text'|'invoke'; interactionKind: string; semanticRole: string; readable: boolean; writable: boolean; automatable: boolean; observable: boolean; idempotency: string; confirmationPolicy: string; riskLevel: string; stepUpPolicy?: string; unsupportedReason?: string|null; sortOrder: number; catalogRevision: number; expectedReportingIntervalSeconds?: number; maxStateValiditySeconds?: number; constraints?: { minimum?: number; maximum?: number; step?: number; precision?: number; unit?: string; options?: Array<{ value: unknown; label: string }> } }
export interface NativeDeviceV1 { id: string; homeId: string; managementClass: 'property_device'|'tenant_device'; ownerMembershipId: string|null; lifecycle: 'commissioning'|'installed'|'view_only'|'retired'; technicalLabel: string; customerLabel: string|null; areaIds: string[]; controls: NativeControlV1[]; descriptorRevision: number }
export interface NativeAlexaContextV1 { homeId: string; homeMembershipId: string; role: 'OWNER'|'PROPERTY_MANAGER'|'TENANT'; authorisedAreaIds: string[] }
export interface NativeAlexaDiscoveryV1 { homeId: string; homeMembershipId: string; selectedAreaIds: string[]; exposureGeneration: number; devices: NativeDeviceV1[] }
const interactionKinds = new Set(['toggle', 'slider', 'thermostat', 'picker', 'text_input', 'momentary_action', 'read_only']);
const semanticRoles = new Set(['power','brightness','active_heat_demand','active_heat_production','target_temperature','ambient_temperature','opening_percentage','connectivity','security_lock','lock_state','operating_mode','position','volume','color','state','unknown']);
const approvedAlexaRoles = new Set(['power','brightness','target_temperature','ambient_temperature','opening_percentage','position','volume']);
const codePointLength = (value: string): number => Array.from(value).length;
const validOpaqueId = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && codePointLength(value) <= 160;
const isUtcTimestamp = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value));
function validControl(control: NativeControlV1, device: NativeDeviceV1): boolean {
  if (!control || typeof control !== 'object' || !Object.prototype.hasOwnProperty.call(control, 'schemaVersion') || control.deviceId !== device.id || control.schemaVersion !== 1 ||
      typeof control.controlId !== 'string' || !control.controlId || typeof control.label !== 'string' || !control.label.trim() || codePointLength(control.label) > 80 ||
      !(control.surfaceId == null || validOpaqueId(control.surfaceId)) || !(control.group == null || typeof control.group === 'string' && codePointLength(control.group) <= 80) ||
      typeof control.semanticRole !== 'string' || !semanticRoles.has(control.semanticRole) ||
      !['boolean','number','option','text','invoke'].includes(control.valueType) || typeof control.interactionKind !== 'string' || !control.interactionKind || codePointLength(control.interactionKind) > 64 ||
      !validOpaqueId(control.controlId) || codePointLength(control.label) > 80 || !(control.unsupportedReason == null || typeof control.unsupportedReason === 'string' && codePointLength(control.unsupportedReason) <= 120) ||
      !['set_value','invoke_once','none'].includes(control.idempotency) || !['none','matching_observation','explicit_user','step_up'].includes(control.confirmationPolicy) ||
      !['low','normal','sensitive','critical'].includes(control.riskLevel) ||
      !['none','required'].includes(control.stepUpPolicy ?? 'none') || typeof control.readable !== 'boolean' || typeof control.writable !== 'boolean' ||
      typeof control.automatable !== 'boolean' || typeof control.observable !== 'boolean' || (control.writable && !control.readable) ||
      (!interactionKinds.has(control.interactionKind) && (control.writable || control.automatable || control.idempotency !== 'none' || control.confirmationPolicy !== 'none' || control.stepUpPolicy !== 'none')) ||
      (control.valueType === 'option' && control.writable && (!Array.isArray(control.constraints?.options) || control.constraints.options.length === 0)) ||
      (control.stepUpPolicy === 'required' && control.automatable) ||
      (['security_lock','lock_state'].includes(control.semanticRole) && (control.stepUpPolicy !== 'required' || control.automatable)) ||
      !Number.isInteger(control.catalogRevision) || control.catalogRevision !== device.descriptorRevision || !Number.isInteger(control.sortOrder) || control.sortOrder < 0) return false;
  const constraints = control.constraints;
  if (constraints) {
    if (typeof constraints !== 'object' || Array.isArray(constraints) || Object.keys(constraints).some((key) => !['minimum','maximum','step','precision','unit','options'].includes(key))) return false;
    const { minimum, maximum, step, precision, options } = constraints;
    if (constraints.unit !== undefined && (typeof constraints.unit !== 'string' || codePointLength(constraints.unit) > 32)) return false;
    if (minimum !== undefined && (typeof minimum !== 'number' || !Number.isFinite(minimum))) return false;
    if (maximum !== undefined && (typeof maximum !== 'number' || !Number.isFinite(maximum))) return false;
    if (typeof minimum === 'number' && typeof maximum === 'number' && minimum > maximum) return false;
    if (step !== undefined && (typeof step !== 'number' || !Number.isFinite(step) || step <= 0)) return false;
    if (precision !== undefined && (!Number.isInteger(precision) || precision < 0 || precision > 12)) return false;
    if (options !== undefined && (!Array.isArray(options) || options.length > 128 || options.some((item) => !item || typeof item !== 'object' || Object.keys(item).some((key) => !['value','label'].includes(key)) || !Object.prototype.hasOwnProperty.call(item, 'value') || typeof item.label !== 'string' || codePointLength(item.label) > 80) || new Set(options.map((item) => JSON.stringify(item.value))).size !== options.length)) return false;
  }
  if (control.observable && (!(Number.isInteger(control.expectedReportingIntervalSeconds) && Number(control.expectedReportingIntervalSeconds) > 0) || !(Number.isInteger(control.maxStateValiditySeconds) && Number(control.maxStateValiditySeconds) > 0))) return false;
  return true;
}
export function decodeNativeAlexaDevices(payload: unknown, context: NativeAlexaContextV1): NativeDeviceV1[] | null {
  if (!['OWNER', 'PROPERTY_MANAGER', 'TENANT'].includes(context.role) || !validOpaqueId(context.homeId) || !validOpaqueId(context.homeMembershipId) || !context.authorisedAreaIds.every(validOpaqueId)) return null;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const body = payload as Record<string, unknown>;
  if (Object.keys(body).some((key) => !['schemaVersion','homeId','streamId','sequence','generatedAt','revision','data'].includes(key)) ||
      body.schemaVersion !== 'dinodia.v1' || body.homeId !== context.homeId || typeof body.streamId !== 'string' || !body.streamId ||
      !Number.isSafeInteger(body.sequence) || Number(body.sequence) < 0 || !Number.isSafeInteger(body.revision) || Number(body.revision) < 0 ||
      !isUtcTimestamp(body.generatedAt) || Date.parse(body.generatedAt) > Date.now() || !Array.isArray(body.data)) return null;
  const devices = body.data as NativeDeviceV1[];
  const projection: NativeDeviceV1[] = [];
  const seenDeviceIds = new Set<string>();
  const allowedDeviceKeys = ['id','homeId','managementClass','ownerMembershipId','lifecycle','technicalLabel','customerLabel','areaIds','controls','descriptorRevision'];
  const allowedControlKeys = ['schemaVersion','deviceId','surfaceId','controlId','label','group','sortOrder','valueType','interactionKind','semanticRole','readable','writable','automatable','observable','idempotency','confirmationPolicy','riskLevel','stepUpPolicy','constraints','expectedReportingIntervalSeconds','maxStateValiditySeconds','unsupportedReason','catalogRevision'];
  for (const d of devices) {
    if (!d || typeof d !== 'object' || Array.isArray(d) || Object.keys(d).some((key) => !allowedDeviceKeys.includes(key)) || !validOpaqueId(d.id) || !validOpaqueId(d.homeId) || d.homeId !== context.homeId || d.lifecycle !== 'installed' || !Array.isArray(d.controls) || !Array.isArray(d.areaIds) || !Number.isInteger(d.descriptorRevision) || d.descriptorRevision < 0 || typeof d.technicalLabel !== 'string' || codePointLength(d.technicalLabel) > 80 || !(d.customerLabel == null || typeof d.customerLabel === 'string' && codePointLength(d.customerLabel) <= 40) || d.areaIds.some((area) => !validOpaqueId(area))) return null;
    if (seenDeviceIds.has(d.id)) return null;
    seenDeviceIds.add(d.id);
    if (d.managementClass === 'tenant_device' && (context.role !== 'TENANT' || d.ownerMembershipId !== context.homeMembershipId)) continue;
    if (d.managementClass === 'property_device' && d.ownerMembershipId !== null) return null;
    if (d.managementClass !== 'tenant_device' && d.managementClass !== 'property_device') return null;
    if (d.controls.some((c) => !c || typeof c !== 'object' || Array.isArray(c) || Object.keys(c).some((key) => !allowedControlKeys.includes(key)) || !validControl(c, d)) || new Set(d.controls.map((control) => control.controlId)).size !== d.controls.length) return null;
    if (!d.areaIds.length || new Set(d.areaIds).size !== d.areaIds.length || !d.areaIds.every((area) => context.authorisedAreaIds.includes(area))) return null;
    const controls = d.controls.filter((c) => c.automatable && c.writable && c.readable && approvedAlexaRoles.has(c.semanticRole) && !['security_lock','lock_state'].includes(c.semanticRole) && c.interactionKind !== 'momentary_action');
    if (controls.length) projection.push({ ...d, controls });
  }
  return projection;
}
export function decodeNativeAlexaDiscovery(payload: unknown): NativeAlexaDiscoveryV1 | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const body = payload as Record<string, unknown>;
  const membership = body.membership as Record<string, unknown> | null;
  if (Object.keys(body).some((key) => !['schemaVersion','homeId','membership','selectedAreaIds','exposureGeneration','data'].includes(key)) ||
      body.schemaVersion !== 'dinodia.v1' || !validOpaqueId(body.homeId) || !membership || Object.keys(membership).some((key) => !['homeMembershipId','role'].includes(key)) ||
      membership.role !== 'TENANT' || !validOpaqueId(membership.homeMembershipId) || !Array.isArray(body.selectedAreaIds) || body.selectedAreaIds.some((id) => !validOpaqueId(id)) || new Set(body.selectedAreaIds).size !== body.selectedAreaIds.length || !Number.isSafeInteger(body.exposureGeneration) || Number(body.exposureGeneration) < 0 || !Array.isArray(body.data)) return null;
  const context: NativeAlexaContextV1 = { homeId: body.homeId, homeMembershipId: membership.homeMembershipId, role: 'TENANT', authorisedAreaIds: body.selectedAreaIds as string[] };
  const devices = projectNativeAlexaDevices(body.data, context);
  if (!devices) return null;
  return { homeId: body.homeId, homeMembershipId: membership.homeMembershipId, selectedAreaIds: [...body.selectedAreaIds] as string[], exposureGeneration: Number(body.exposureGeneration), devices };
}
function projectNativeAlexaDevices(data: unknown[], context: NativeAlexaContextV1): NativeDeviceV1[] | null {
  const payload = { schemaVersion: 'dinodia.v1', homeId: context.homeId, streamId: 'alexa-discovery', sequence: 0, generatedAt: new Date().toISOString(), revision: 0, data };
  return decodeNativeAlexaDevices(payload, context);
}
export function alexaEndpointId(homeId: string, deviceId: string): string { return `dos_${createHash('sha256').update(homeId).update('\0').update(deviceId).digest('hex')}`; }
