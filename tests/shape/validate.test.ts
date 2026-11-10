import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../src/router/errors.js';
import { checkIPv4, checkPort, isIPv4, isMac, normDomain, normMac } from '../../src/shape/validate.js';

describe('normMac', () => {
  it.each([
    ['AA:BB:CC:DD:EE:FF', 'aa:bb:cc:dd:ee:ff'],
    ['aa-bb-cc-dd-ee-ff', 'aa:bb:cc:dd:ee:ff'],
    ['  02:00:00:00:00:01 ', '02:00:00:00:00:01']
  ])('normalizes %s', (input, expected) => {
    expect(normMac(input)).toBe(expected);
  });

  it.each(['', 'aa:bb:cc:dd:ee', 'aa:bb:cc:dd:ee:gg', '192.0.2.1', 'aabbccddeeff'])(
    'refuses %j with an error the model can act on',
    input => {
      expect(() => normMac(input)).toThrow(ValidationError);
      expect(isMac(input)).toBe(false);
    }
  );
});

describe('isIPv4', () => {
  it.each(['192.0.2.1', '0.0.0.0', '255.255.255.255'])('accepts %s', ip => {
    expect(isIPv4(ip)).toBe(true);
  });

  // The old pattern only counted digits, so all of these went to the router.
  it.each(['999.1.1.1', '192.0.2.256', '192.0.2', '192.0.2.1.5', ' 192.0.2.1', '192.0.2.1/24', 'a.b.c.d'])(
    'refuses %j',
    ip => {
      expect(isIPv4(ip)).toBe(false);
      expect(() => checkIPv4(ip)).toThrow(ValidationError);
    }
  );
});

describe('normDomain and checkPort', () => {
  it('lowercases and drops a trailing dot', () => {
    expect(normDomain('NAS.Home.Example.')).toBe('nas.home.example');
  });

  it('refuses a name with a space or an empty label', () => {
    expect(() => normDomain('my nas')).toThrow(ValidationError);
    expect(() => normDomain('a..b')).toThrow(ValidationError);
  });

  it('holds ports to 1-65535', () => {
    expect(checkPort(443)).toBe(443);
    expect(() => checkPort(0)).toThrow(ValidationError);
    expect(() => checkPort(65536)).toThrow(ValidationError);
    expect(() => checkPort(80.5)).toThrow(ValidationError);
  });
});
