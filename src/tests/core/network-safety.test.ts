import { isPrivateIPv4 } from '../../shared/network-safety.js';

describe('isPrivateIPv4', () => {
  it('10.x.x.x is private', () => {
    expect(isPrivateIPv4(10, 0)).toBe(true);
    expect(isPrivateIPv4(10, 255)).toBe(true);
  });

  it('172.16-31.x.x is private', () => {
    expect(isPrivateIPv4(172, 16)).toBe(true);
    expect(isPrivateIPv4(172, 31)).toBe(true);
    expect(isPrivateIPv4(172, 24)).toBe(true);
  });

  it('172.15.x.x and 172.32.x.x are NOT private', () => {
    expect(isPrivateIPv4(172, 15)).toBe(false);
    expect(isPrivateIPv4(172, 32)).toBe(false);
  });

  it('192.168.x.x is private', () => {
    expect(isPrivateIPv4(192, 168)).toBe(true);
  });

  it('192.169.x.x is NOT private', () => {
    expect(isPrivateIPv4(192, 169)).toBe(false);
  });

  it('127.x.x.x is loopback', () => {
    expect(isPrivateIPv4(127, 0)).toBe(true);
    expect(isPrivateIPv4(127, 1)).toBe(true);
  });

  it('public IPs are NOT private', () => {
    expect(isPrivateIPv4(8, 8)).toBe(false);
    expect(isPrivateIPv4(203, 0)).toBe(false);
    expect(isPrivateIPv4(1, 2)).toBe(false);
  });
});
