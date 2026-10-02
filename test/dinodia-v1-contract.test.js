const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { decodeNativeAlexaDevices, decodeNativeAlexaDiscovery, alexaEndpointId } = require('../dist/dinodiaV1.js');
const root = path.join(__dirname, 'fixtures/dinodia-v1');
const fixture = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/multi-control-device.json'), 'utf8'));
const context = { homeId: fixture.context.homeId, homeMembershipId: fixture.context.homeMembershipId, role: 'OWNER', authorisedAreaIds: ['area:living'] };
const catalog = (data, extra = {}) => ({ schemaVersion: 'dinodia.v1', homeId: context.homeId, streamId: 'stream:test', sequence: 1, generatedAt: '2026-09-27T10:00:00Z', revision: 1, data, ...extra });
test('Alexa contract adapter rejects wrong version/home and private tenant devices while omitting app-only controls', () => {
  const projected = decodeNativeAlexaDevices(catalog([fixture.device]), context);
  assert.equal(projected?.length, 1);
  assert.equal(projected[0].controls.some((control) => control.confirmationPolicy === 'step_up'), false);
  assert.equal(decodeNativeAlexaDevices(catalog([], { schemaVersion: 'dinodia.v0' }), context), null);
  assert.equal(decodeNativeAlexaDevices(catalog([], { homeId: 'home:other' }), context), null);
  const safe = { ...fixture.device, controls: fixture.device.controls.slice(0, 2) };
  assert.equal(decodeNativeAlexaDevices(catalog([safe]), context)?.length, 1);
  const ownPrivate = { ...safe, managementClass: 'tenant_device', ownerMembershipId: 'membership:tenant-a' };
  const tenantContext = { ...context, role: 'TENANT', homeMembershipId: 'membership:tenant-a' };
  assert.equal(decodeNativeAlexaDevices({ ...catalog([ownPrivate]), homeId: context.homeId }, tenantContext)?.length, 1);
  assert.deepEqual(decodeNativeAlexaDevices(catalog([ownPrivate]), context), []);
  assert.deepEqual(decodeNativeAlexaDevices(catalog([{ ...ownPrivate, ownerMembershipId: 'membership:tenant-b' }]), tenantContext), []);
  const forgedLock = { ...safe, controls: [{ ...fixture.device.controls.find((control) => control.controlId === 'control:lock'), automatable: true, stepUpPolicy: 'none', confirmationPolicy: 'none' }] };
  assert.equal(decodeNativeAlexaDevices(catalog([forgedLock]), context), null);
  assert.equal(decodeNativeAlexaDevices(catalog([{ ...safe, entity_id: 'light.private' }]), context), null);
});
test('Alexa endpoint identity is opaque and home-scoped', () => assert.notEqual(alexaEndpointId('home:a', 'device:x'), alexaEndpointId('home:b', 'device:x')));
test('Alexa discovery adapter applies selected membership, area exposure generation and app-only control exclusions', () => {
  const source = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/alexa-discovery-projection.json'), 'utf8'));
  const projection = decodeNativeAlexaDiscovery(source);
  assert.ok(projection);
  assert.equal(projection.homeId, source.homeId);
  assert.equal(projection.homeMembershipId, source.membership.homeMembershipId);
  assert.deepEqual(projection.selectedAreaIds, source.selectedAreaIds);
  assert.equal(projection.exposureGeneration, source.exposureGeneration);
  assert.equal(projection.devices.length, 1, 'tenant-owned device without exposed eligible controls is not projected');
  assert.deepEqual(projection.devices[0].controls.map((control) => control.controlId), ['control:power', 'control:brightness']);
  assert.equal(projection.devices[0].controls.some((control) => ['security_lock', 'lock_state'].includes(control.semanticRole)), false);

  assert.equal(decodeNativeAlexaDiscovery({ ...source, membership: { ...source.membership, role: 'OWNER' } }), null);
  assert.equal(decodeNativeAlexaDiscovery({ ...source, selectedAreaIds: ['area:bedroom'] }), null, 'device data outside the selected-area projection is rejected');
  assert.equal(decodeNativeAlexaDiscovery({ ...source, exposureGeneration: -1 }), null);
  assert.equal(decodeNativeAlexaDiscovery({ ...source, supportOverride: true }), null, 'unknown authority metadata is rejected');

  const changedOwner = structuredClone(source);
  changedOwner.data[1].ownerMembershipId = 'membership:tenant-b';
  const privateProjection = decodeNativeAlexaDiscovery(changedOwner);
  assert.ok(privateProjection);
  assert.deepEqual(privateProjection.devices.map((device) => device.id), ['device:opaque-1'], 'a different tenant’s private device never crosses the projection');
});
test('Alexa package carries the shared lifecycle and privacy decision fixture', () => {
  const decisions = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/stage2-decision-matrix.json'), 'utf8'));
  assert.equal(decisions.schemaVersion, 'dinodia.v1');
  assert.equal(decisions.controls.securityControlAlexaExposed, false);
  assert.equal(decisions.notification.tenantDeviceAudience, 'owning_membership_only');
  assert.equal(decisions.tenantPrivacy.ownerCanRead, false);
  assert.equal(decisions.replacement.nameBasedMergeAllowed, false);
  assert.equal(decisions.automation.saveRequiresCurrentRevision, true);
  assert.equal(decisions.automation.staleRevisionIsRejectedWithoutMerge, true);
  assert.equal(decisions.automation.presentationLabelsGrantCapability, false);
  assert.equal(decisions.alexa.activeMembershipRole, 'TENANT');
  assert.equal(decisions.alexa.selectedAreaIdsAreAuthoritative, true);
  assert.equal(decisions.alexa.ownTenantDeviceEligible, true);
  assert.equal(decisions.alexa.otherTenantDeviceEligible, false);
  assert.equal(decisions.alexa.appOnlySecurityControlEligible, false);
  assert.equal(decisions.trustedDevice.removalRevokesAccountInstallation, true);
  assert.equal(decisions.trustedDevice.offlineReenrollmentAllowed, false);
  assert.equal(decisions.provisioning.cloudUrlIndependentlyVerified, true);
  assert.equal(decisions.provisioning.manufacturingRootPrivateKeyOnHub, false);
  assert.equal(decisions.roomQr.claimReservationFirstWins, true);
  assert.deepEqual(decisions.support.categories, ['ACCOUNT_OR_SIGN_IN', 'ACCESS_OR_PERMISSIONS', 'DEVICE_PROBLEM', 'HUB_OR_CONNECTION', 'AUTOMATION', 'ALEXA', 'OTHER']);
  assert.equal(decisions.support.privateTenantDeviceTicketVisibleToOwner, false);
  assert.equal(decisions.support.infrastructureNoticeContainsTenantPrivateDetails, false);
  assert.deepEqual(decisions.notifications.channels, ['push', 'verified_email']);
  assert.equal(decisions.notifications.deliveryReceiptGrantsAuthority, false);
  assert.equal(decisions.offline.policyAppliedBeforeConnected, true);
});
test('Alexa rejects malformed bounds, duplicate controls and unattended step-up controls', () => {
  const safe = { ...fixture.device, controls: fixture.device.controls.slice(0, 2) };
  const decode = (device) => decodeNativeAlexaDevices(catalog([device]), context);
  assert.equal(decode({ ...safe, controls: [{ ...safe.controls[0], constraints: { minimum: 100, maximum: 10 } }, safe.controls[1] ] }), null);
  assert.equal(decode({ ...safe, controls: [{ ...safe.controls[0], constraints: { minimum: 0, maximum: 100, step: 0 } }, safe.controls[1] ] }), null);
  assert.equal(decode({ ...safe, controls: [{ ...safe.controls[0], constraints: { precision: 13 } }, safe.controls[1] ] }), null);
  assert.equal(decode({ ...safe, controls: [{ ...safe.controls[0], constraints: { options: [{ value: 'x', label: 'X', adminOnly: true }] } }, safe.controls[1] ] }), null);
  assert.equal(decode({ ...safe, controls: [{ ...safe.controls[0], valueType: 'option', interactionKind: 'picker', constraints: { options: [] } }, safe.controls[1] ] }), null);
  assert.equal(decode({ ...safe, controls: [{ ...safe.controls[0], stepUpPolicy: 'required', automatable: true }, safe.controls[1] ] }), null);
  assert.equal(decode({ ...safe, controls: [safe.controls[0], safe.controls[0]] }), null);
  assert.equal(decode({ ...safe, controls: [{ ...safe.controls[0], readable: false }, safe.controls[1]] }), null, 'a writable descriptor cannot be unreadable');
});
test('Alexa consumes the shared duplicate-control-ID negative before capability projection', () => {
  const mutation = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/invalid/duplicate-device-control-id.json'), 'utf8'));
  const source = JSON.parse(fs.readFileSync(path.join(root, mutation.sourceFixture), 'utf8'));
  const device = structuredClone(source.device);
  const target = device.controls.find((control) => control.controlId === mutation.targetControlId);
  assert.ok(target);
  target.controlId = mutation.duplicateControlId;
  assert.equal(mutation.expected, 'reject_descriptor_before_projection_or_dispatch');
  assert.equal(decodeNativeAlexaDevices(catalog([device]), context), null);
});
test('Alexa keeps unknown interactions non-authoritative and rejects commandable unknown descriptors', () => {
  const unknown = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/unknown-interaction-kind.json'), 'utf8'));
  const unknownResult = decodeNativeAlexaDevices(catalog([{ ...unknown.device, lifecycle: 'installed' }]), { ...context, authorisedAreaIds: unknown.device.areaIds });
  assert.deepEqual(unknownResult, [], 'a safe unknown interaction is valid but omitted from Alexa control exposure');

  const unknownMutation = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/invalid/unknown-interaction-commandable.json'), 'utf8'));
  const unknownSource = JSON.parse(fs.readFileSync(path.join(root, 'fixtures', unknownMutation.sourceFixture.replace(/^fixtures\//, '')), 'utf8'));
  const unsafeUnknown = structuredClone(unknownSource.device);
  Object.assign(unsafeUnknown.controls.find((control) => control.controlId === unknownMutation.controlId), unknownMutation.mutation);
  assert.equal(decodeNativeAlexaDevices(catalog([unsafeUnknown]), context), null, unknownMutation.expected);

  const mutation = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/invalid/writable-unreadable-control.json'), 'utf8'));
  const source = JSON.parse(fs.readFileSync(path.join(root, mutation.sourceFixture), 'utf8'));
  const device = structuredClone(source.device);
  const control = device.controls.find((candidate) => candidate.controlId === mutation.mutation.controlId);
  Object.assign(control, mutation.mutation);
  assert.equal(decodeNativeAlexaDevices(catalog([device]), context), null, mutation.expectedOutcome);
});
test('Alexa rejects malformed canonical envelope metadata and extra authority fields', () => {
  const payload = catalog([]);
  for (const malformed of [
    { ...payload, generatedAt: 'not-a-timestamp' },
    { ...payload, sequence: -1 },
    { ...payload, revision: -1 },
    { ...payload, authority: 'forged' },
    { ...payload, generatedAt: '2099-01-01T00:00:00Z' },
  ]) assert.equal(decodeNativeAlexaDevices(malformed, context), null);
  const impossibleDate = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/invalid/impossible-calendar-date-envelope.json'), 'utf8'));
  assert.equal(decodeNativeAlexaDevices(impossibleDate, context), null, 'calendar-invalid dates must not pass because Date.parse normalizes them');
});
test('Alexa rejects a descriptor that omits required stepUpPolicy before projection', () => {
  const mutation = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/invalid/device-missing-step-up-policy.json'), 'utf8'));
  const source = JSON.parse(fs.readFileSync(path.join(root, 'fixtures', mutation.sourceFixture.replace(/^fixtures\//, '')), 'utf8'));
  const device = structuredClone(source.device);
  const control = device.controls.find((item) => item.controlId === mutation.controlId);
  assert.ok(control);
  delete control[mutation.removeField];
  assert.equal(decodeNativeAlexaDevices(catalog([device]), context), null);
});
test('Alexa rejects a descriptor with a noncanonical stepUpPolicy before projection', () => {
  const mutation = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/invalid/device-invalid-step-up-policy.json'), 'utf8'));
  const source = JSON.parse(fs.readFileSync(path.join(root, mutation.sourceFixture), 'utf8'));
  const device = structuredClone(source.device);
  const control = device.controls.find((item) => item.controlId === mutation.controlId);
  assert.ok(control);
  control[mutation.field] = mutation.invalidValue;
  assert.equal(decodeNativeAlexaDevices(catalog([device]), context), null);
});
test('Alexa enforces code-point label limits and rejects duplicate device identities', () => {
  const labels = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/customer-label-unicode-boundaries.json'), 'utf8'));
  const safe = { ...fixture.device, controls: fixture.device.controls.slice(0, 2) };
  for (const item of labels.cases) {
    const raw = typeof item.value === 'string' ? item.value : String(item.repeat || '').repeat(Number(item.repeatCount || 0));
    const result = decodeNativeAlexaDevices(catalog([{ ...safe, customerLabel: raw }]), context);
    assert.notEqual(result === null, item.wireValid === true, `Alexa label ${item.id}`);
  }
  assert.equal(decodeNativeAlexaDevices(catalog([safe, safe]), context), null, 'duplicate opaque device IDs invalidate the entire envelope');
});
test('Alexa consumes shared Unicode-code-point descriptor bounds without changing exposure authority', () => {
  const bounds = JSON.parse(fs.readFileSync(path.join(root, 'fixtures/bounded-string-unicode-semantics.json'), 'utf8'));
  const base = { ...fixture.device, controls: fixture.device.controls.slice(0, 2) };
  const repeat = (item, count) => item.repeat.repeat(count);
  const decode = (device) => decodeNativeAlexaDevices(catalog([device]), context);
  assert.equal(bounds.lengthUnit, 'unicode_code_points');
  for (const item of [...bounds.boundaryCases, ...bounds.combiningSequenceCases]) {
    const at = repeat(item, item.validRepeatCount);
    const over = repeat(item, item.invalidRepeatCount);
    if (item.field === 'opaqueId') {
      const withId = (id) => ({ ...base, id, controls: base.controls.map((control) => ({ ...control, deviceId: id })) });
      assert.ok(decode(withId(at)), `${item.id} at limit`);
      assert.equal(decode(withId(over)), null, `${item.id} over limit`);
    } else if (item.field === 'controlLabel') {
      const withLabel = (label) => ({ ...base, controls: base.controls.map((control, index) => index ? control : { ...control, label }) });
      assert.ok(decode(withLabel(at)), `${item.id} at limit`);
      assert.equal(decode(withLabel(over)), null, `${item.id} over limit`);
    } else if (item.field === 'constraintUnit' || item.field === 'optionLabel') {
      const optionControl = { ...base.controls[0], valueType: 'option', interactionKind: 'picker', constraints: { unit: item.field === 'constraintUnit' ? at : 'mode', options: [{ value: 'on', label: item.field === 'optionLabel' ? at : 'On' }] } };
      assert.ok(decode({ ...base, controls: [optionControl] }), `${item.id} at limit`);
      const invalidControl = { ...optionControl, constraints: { ...optionControl.constraints, unit: item.field === 'constraintUnit' ? over : optionControl.constraints.unit, options: [{ value: 'on', label: item.field === 'optionLabel' ? over : 'On' }] } };
      assert.equal(decode({ ...base, controls: [invalidControl] }), null, `${item.id} over limit`);
    }
  }
});
