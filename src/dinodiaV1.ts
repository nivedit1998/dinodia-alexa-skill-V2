export interface NativeControlV1 { schemaVersion: number; deviceId: string; surfaceId?: string|null; controlId: string; label: string; group?: string|null; valueType: 'boolean'|'number'|'option'|'text'|'invoke'; interactionKind: string; semanticRole: string; readable: boolean; writable: boolean; automatable: boolean; observable: boolean; idempotency: string; confirmationPolicy: string; riskLevel: string; stepUpPolicy: string; unsupportedReason?: string|null; sortOrder: number; catalogRevision: number; expectedReportingIntervalSeconds?: number; maxStateValiditySeconds?: number; constraints?: { minimum?: number; maximum?: number; step?: number; precision?: number; unit?: string; options?: Array<{ value: unknown; label: string }> } }
export interface NativeDeviceV1 { id: string; homeId: string; managementClass: 'property_device'|'tenant_device'; ownerMembershipId: string|null; lifecycle: 'commissioning'|'installed'|'view_only'|'retired'; technicalLabel: string; customerLabel: string|null; areaIds: string[]; controls: NativeControlV1[]; descriptorRevision: number }
export interface NativeAlexaContextV1 { homeId: string; homeMembershipId: string; role: 'OWNER'|'PROPERTY_MANAGER'|'TENANT'; authorisedAreaIds: string[] }
export interface NativeAlexaDiscoveredDeviceV1 extends NativeDeviceV1 {
  endpointId: string;
  friendlyName: string;
  propertyPostcode: string;
  areaName: string;
  homeMembershipId: string;
  selectedAreaIds: string[];
  exposureGeneration: number;
}
export interface NativeAlexaDiscoveryV1 { devices: NativeAlexaDiscoveredDeviceV1[] }
const interactionKinds = new Set(['toggle', 'slider', 'thermostat', 'picker', 'text_input', 'momentary_action', 'read_only']);
const semanticRoles = new Set(['power','brightness','active_heat_demand','active_heat_production','target_temperature','ambient_temperature','opening_percentage','connectivity','security_lock','lock_state','operating_mode','position','volume','color','state','unknown']);
const approvedAlexaRoles = new Set(['power','brightness','target_temperature','ambient_temperature','opening_percentage','position','volume']);
const codePointLength = (value: string): number => Array.from(value).length;
const validOpaqueId = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && codePointLength(value) <= 160;
const isUtcTimestamp = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText); const month = Number(monthText); const day = Number(dayText);
  const hour = Number(hourText); const minute = Number(minuteText); const second = Number(secondText);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return day >= 1 && day <= daysInMonth && Number.isFinite(Date.parse(value));
};
function validControl(control: NativeControlV1, device: NativeDeviceV1): boolean {
  if (!control || typeof control !== 'object' || !Object.prototype.hasOwnProperty.call(control, 'schemaVersion') || control.deviceId !== device.id || control.schemaVersion !== 1 ||
      typeof control.controlId !== 'string' || !control.controlId || typeof control.label !== 'string' || !control.label.trim() || codePointLength(control.label) > 80 ||
      !(control.surfaceId == null || validOpaqueId(control.surfaceId)) || !(control.group == null || typeof control.group === 'string' && codePointLength(control.group) <= 80) ||
      typeof control.semanticRole !== 'string' || !semanticRoles.has(control.semanticRole) ||
      !['boolean','number','option','text','invoke'].includes(control.valueType) || typeof control.interactionKind !== 'string' || !control.interactionKind || codePointLength(control.interactionKind) > 64 ||
      !validOpaqueId(control.controlId) || codePointLength(control.label) > 80 || !(control.unsupportedReason == null || typeof control.unsupportedReason === 'string' && codePointLength(control.unsupportedReason) <= 120) ||
      !['set_value','invoke_once','none'].includes(control.idempotency) || !['none','matching_observation','explicit_user','step_up'].includes(control.confirmationPolicy) ||
      !['low','normal','sensitive','critical'].includes(control.riskLevel) ||
      !['none','required'].includes(control.stepUpPolicy) || typeof control.readable !== 'boolean' || typeof control.writable !== 'boolean' ||
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
    const controls = d.controls.filter((c) => {
      if (!approvedAlexaRoles.has(c.semanticRole) || ['security_lock','lock_state'].includes(c.semanticRole) || c.interactionKind === 'momentary_action') return false;
      if (c.semanticRole === 'ambient_temperature') return c.readable && c.observable && !c.writable && !c.automatable;
      return c.automatable && c.writable && c.readable;
    });
    if (controls.length) projection.push({ ...d, controls });
  }
  return projection;
}
export function decodeNativeAlexaDiscovery(payload: unknown): NativeAlexaDiscoveryV1 | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const body = payload as Record<string, unknown>;
  if (Object.keys(body).some((key) => !['schemaVersion','properties'].includes(key))
      || body.schemaVersion !== 'dinodia.v1' || !Array.isArray(body.properties) || body.properties.length > 100) return null;
  const seenEndpointIds = new Set<string>();
  const seenHomeMemberships = new Set<string>();
  const devices: NativeAlexaDiscoveredDeviceV1[] = [];
  for (const propertyValue of body.properties) {
    if (!propertyValue || typeof propertyValue !== 'object' || Array.isArray(propertyValue)) return null;
    const property = propertyValue as Record<string, unknown>;
    const membership = property.membership as Record<string, unknown> | null;
    if (Object.keys(property).some((key) => !['homeId','membership','selectedAreaIds','exposureGeneration','postcode','data'].includes(key))
        || !validOpaqueId(property.homeId) || typeof property.postcode !== 'string' || codePointLength(property.postcode) > 20
        || !membership || Object.keys(membership).some((key) => !['homeMembershipId','role'].includes(key))
        || membership.role !== 'TENANT' || !validOpaqueId(membership.homeMembershipId)
        || !Array.isArray(property.selectedAreaIds) || property.selectedAreaIds.length === 0
        || property.selectedAreaIds.some((id) => !validOpaqueId(id)) || new Set(property.selectedAreaIds).size !== property.selectedAreaIds.length
        || !Number.isSafeInteger(property.exposureGeneration) || Number(property.exposureGeneration) < 1
        || !Array.isArray(property.data) || property.data.length > 512) return null;
    if (seenHomeMemberships.has(membership.homeMembershipId)) return null;
    const homeMembershipId = membership.homeMembershipId as string;
    const selectedAreaIds = property.selectedAreaIds as string[];
    const propertyPostcode = property.postcode as string;
    seenHomeMemberships.add(homeMembershipId);
    const context: NativeAlexaContextV1 = { homeId: property.homeId, homeMembershipId, role: 'TENANT', authorisedAreaIds: selectedAreaIds };
    const endpointIdsByDevice = new Map<string, { endpointId: string; friendlyName: string; areaName: string }>();
    const deviceRows: unknown[] = [];
    for (const item of property.data) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
      const row = item as Record<string, unknown>;
      if (Object.keys(row).some((key) => !['endpointId','friendlyName','propertyPostcode','areaName','id','homeId','managementClass','ownerMembershipId','lifecycle','technicalLabel','customerLabel','areaIds','controls','descriptorRevision'].includes(key))
          || typeof row.endpointId !== 'string' || !/^dos_[A-Za-z0-9_-]{16,80}$/.test(row.endpointId)
          || seenEndpointIds.has(row.endpointId) || typeof row.id !== 'string' || typeof row.friendlyName !== 'string'
          || !row.friendlyName.trim() || codePointLength(row.friendlyName) > 160 || row.propertyPostcode !== property.postcode
          || typeof row.areaName !== 'string' || codePointLength(row.areaName) > 160) return null;
      seenEndpointIds.add(row.endpointId);
      endpointIdsByDevice.set(row.id, { endpointId: row.endpointId, friendlyName: row.friendlyName, areaName: row.areaName });
      const { endpointId: _endpointId, friendlyName: _friendlyName, propertyPostcode: _postcode, areaName: _areaName, ...device } = row;
      void _endpointId; void _friendlyName; void _postcode; void _areaName;
      deviceRows.push(device);
    }
    const projected = projectNativeAlexaDevices(deviceRows, context);
    if (!projected) return null;
    const propertyDevices = projected.flatMap((device) => {
      const presentation = endpointIdsByDevice.get(device.id);
      return presentation ? [{ ...device, ...presentation, propertyPostcode,
        homeMembershipId, selectedAreaIds: [...selectedAreaIds],
        exposureGeneration: Number(property.exposureGeneration) }] : [];
    });
    if (propertyDevices.length !== projected.length) return null;
    devices.push(...propertyDevices);
  }
  return { devices };
}
function projectNativeAlexaDevices(data: unknown[], context: NativeAlexaContextV1): NativeDeviceV1[] | null {
  const payload = { schemaVersion: 'dinodia.v1', homeId: context.homeId, streamId: 'alexa-discovery', sequence: 0, generatedAt: new Date().toISOString(), revision: 0, data };
  return decodeNativeAlexaDevices(payload, context);
}
