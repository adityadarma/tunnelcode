import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deviceNameFrom } from '../dist/device-name.js';

/**
 * The hostname a machine reports cannot be set from a test, so the choice is
 * tested on the shapes rather than on this machine.
 *
 * Every address shape here is one a DHCP lease actually produces, which is why
 * this exists at all: the phone lists the device name, and an address is both
 * unreadable and stale as soon as the lease changes.
 */

test('a real hostname is kept as it is', () => {
  assert.equal(deviceNameFrom('workstation', 'aditya'), 'workstation');
  assert.equal(deviceNameFrom('Adityas-MacBook-Pro', 'aditya'), 'Adityas-MacBook-Pro');
});

test('the resolver suffix is removed', () => {
  // mDNS appends .local on macOS, and a router appends the rest. None of it is
  // part of the name anybody gave the machine.
  assert.equal(deviceNameFrom('Adityas-MacBook-Pro.local', 'aditya'), 'Adityas-MacBook-Pro');
  assert.equal(deviceNameFrom('workstation.lan', 'aditya'), 'workstation');
  assert.equal(deviceNameFrom('workstation.localdomain', 'aditya'), 'workstation');
});

test('an address is not accepted as a device name', () => {
  // What the report was about: the hostname came back as the lease, so the phone
  // showed an address as the machine it was paired to.
  assert.equal(deviceNameFrom('192.168.1.20', 'aditya'), "aditya's device");
  assert.equal(deviceNameFrom('10.0.0.4', 'aditya'), "aditya's device");
  assert.equal(deviceNameFrom('192.168.1.20.local', 'aditya'), "aditya's device");
});

test('an address dressed as a name is not accepted either', () => {
  // Dashes instead of dots is what an ISP hands back, and it reads as a name to
  // anything that only checks for dotted quads.
  assert.equal(deviceNameFrom('192-168-1-20', 'aditya'), "aditya's device");
  assert.equal(deviceNameFrom('192-168-1-20.isp.net', 'aditya'), "aditya's device");
  assert.equal(deviceNameFrom('192.168.1.20.dynamic.isp.net', 'aditya'), "aditya's device");
});

test('an ipv6 hostname is not accepted', () => {
  assert.equal(deviceNameFrom('fe80::1', 'aditya'), "aditya's device");
});

test('a name that merely starts with a number is kept', () => {
  // Three numeric labels is not an address, and refusing them would rename
  // machines that are legitimately called this.
  assert.equal(deviceNameFrom('2nd-floor-mac', 'aditya'), '2nd-floor-mac');
  assert.equal(deviceNameFrom('10.build.example.com', 'aditya'), '10.build.example.com');
});

test('an empty hostname falls back to the login name', () => {
  assert.equal(deviceNameFrom('', 'aditya'), "aditya's device");
  assert.equal(deviceNameFrom('   ', 'aditya'), "aditya's device");
});

test('with no usable name at all a placeholder is stored', () => {
  // A container can have neither a hostname nor a passwd entry, and the schema
  // requires a non-empty name, so something has to be written.
  assert.equal(deviceNameFrom('192.168.1.20', undefined), 'unknown-device');
  assert.equal(deviceNameFrom('', ''), 'unknown-device');
});
