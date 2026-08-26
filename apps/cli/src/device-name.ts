import { hostname, userInfo } from 'node:os';

const FALLBACK_NAME = 'unknown-device';

/**
 * Suffixes a machine name carries because of how it was resolved, not because
 * anybody named it that.
 *
 * `.local` is what mDNS appends on macOS, and the others are what a router hands
 * back. None of them is part of the name a user would recognise, and the whole
 * point of this file is that the name is read by a person on a phone.
 */
const RESOLVER_SUFFIXES = ['.local', '.lan', '.home', '.localdomain', '.internal'];

/** Matches a dotted-quad, including the partial forms a truncated name leaves. */
const IPV4 = /^\d{1,3}(\.\d{1,3}){1,3}$/;

/**
 * Matches a name that is an address with the dots swapped for dashes.
 *
 * This is the shape a DHCP name takes rather than an address proper:
 * `192-168-1-20`, sometimes with the ISP's domain behind it. It reads as a name
 * to anything checking for an address, which is why it is checked separately.
 */
const DASHED_IPV4 = /(^|[.-])\d{1,3}-\d{1,3}-\d{1,3}-\d{1,3}($|[.-])/;

/** Matches something that is only hex groups and colons, which is IPv6 or nothing. */
const IPV6 = /^[0-9a-f]*:[0-9a-f:]*$/i;

/** Removes the part of a name that says how it was resolved rather than what it is. */
function stripResolverSuffix(value: string): string {
  const lowered = value.toLowerCase();

  for (const suffix of RESOLVER_SUFFIXES) {
    if (lowered.endsWith(suffix) && value.length > suffix.length) {
      return value.slice(0, -suffix.length);
    }
  }

  return value;
}

/**
 * True when a name is an address, or is built out of one.
 *
 * Checked on the whole name and on its first label, because an address dressed as
 * a name keeps the dots: `192.168.1.20.dynamic.isp.net` is an address with a
 * domain behind it, and the leading label is what gives it away.
 */
function looksLikeAddress(value: string): boolean {
  if (IPV4.test(value) || IPV6.test(value) || DASHED_IPV4.test(value)) {
    return true;
  }

  const labels = value.split('.');

  // Four numeric labels in a row is an address whatever follows them. Fewer is
  // not enough to be sure, since a name may legitimately start with a number.
  return labels.length >= 4 && labels.slice(0, 4).every((label) => /^\d{1,3}$/.test(label));
}

/**
 * Reads the login name, which is a name a person chose, unlike an address.
 *
 * Wrapped because `userInfo` throws when the account has no passwd entry, which
 * happens in containers, and a device name is not worth failing a first run over.
 */
function loginName(): string | undefined {
  try {
    const name = userInfo().username.trim();
    return name === '' ? undefined : name;
  } catch {
    return undefined;
  }
}

/**
 * Chooses a device name from the two names a machine can report.
 *
 * Separate from reading them so the choice can be tested against the shapes that
 * prompted this, which is the whole reason this file exists: a hostname cannot be
 * set from a test, and `192-168-1-20.isp.net` is not something a developer
 * machine reports on demand.
 *
 * Precedence, most recognisable first:
 *
 * 1. the hostname, with the resolver's own suffix removed
 * 2. `<login name>'s device`, when the hostname is an address
 * 3. a fixed placeholder, when there is no login name either
 */
export function deviceNameFrom(rawHostname: string, login: string | undefined): string {
  const name = stripResolverSuffix(rawHostname.trim());

  if (name !== '' && !looksLikeAddress(name)) {
    return name;
  }

  const chosen = login?.trim();

  return chosen === undefined || chosen === '' ? FALLBACK_NAME : `${chosen}'s device`;
}

/**
 * Resolves the device name to store when a machine has never been set up.
 *
 * The hostname is still the answer in the ordinary case, and ADR-056 stands: this
 * is a value the machine already carries, and nothing here is read from the
 * environment. What changed is that an address is no longer accepted as one.
 *
 * On macOS and on most routed networks the hostname is not something the user
 * typed. It is whatever DHCP handed back, so it arrives as `192.168.1.20`,
 * `192-168-1-20.isp.net` or the same thing with `.local` on the end, and that is
 * what the phone then lists as the device it is paired to. An address is also the
 * one form of name that stops identifying the machine the moment it reconnects,
 * so storing it is wrong even where it is readable.
 *
 * A fallback built from the login name is a guess, but it is a stable one and it
 * names a person rather than a lease. Setup is still where this is corrected, and
 * that is the point of keeping the value obviously human: a name that reads as
 * placeholder invites the correction, where an address reads as a fault.
 */
export function resolveDefaultDeviceName(): string {
  return deviceNameFrom(hostname(), loginName());
}
