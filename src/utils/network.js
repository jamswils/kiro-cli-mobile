/**
 * Network utilities for cross-platform local IP detection.
 * Mirrors kiro-mobile-bridge/src/utils/network.js so this project is
 * self-contained.
 */
import { networkInterfaces } from 'os';

function isIPv4(iface) {
  return iface.family === 'IPv4' || iface.family === 4;
}

function isVirtualInterface(name) {
  const lowerName = name.toLowerCase();
  const virtualPatterns = [
    'vethernet', 'docker', 'vmware', 'virtualbox', 'vbox', 'virbr', 'br-',
    'veth', 'tailscale', 'tun', 'tap', 'utun', 'awdl', 'llw', 'bridge',
    'ham', 'zt'
  ];
  return virtualPatterns.some(pattern => lowerName.includes(pattern));
}

export function getLocalIP() {
  const interfaces = networkInterfaces();
  const priorityInterfaces = [
    'Ethernet', 'Wi-Fi', 'Ethernet 2', 'Local Area Connection',
    'en0', 'en1', 'en2', 'en3', 'en4', 'en5',
    'eth0', 'eth1', 'wlan0', 'wlan1',
    'enp0s3', 'enp0s25', 'enp0s31f6', 'ens33', 'ens160', 'ens192',
    'wlp2s0', 'wlp3s0', 'wlp0s20f3'
  ];

  for (const name of priorityInterfaces) {
    const ifaces = interfaces[name];
    if (!ifaces) continue;
    for (const iface of ifaces) {
      if (isIPv4(iface) && !iface.internal) return iface.address;
    }
  }

  for (const name of Object.keys(interfaces)) {
    if (isVirtualInterface(name)) continue;
    for (const iface of interfaces[name]) {
      if (isIPv4(iface) && !iface.internal) return iface.address;
    }
  }

  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (isIPv4(iface) && !iface.internal) return iface.address;
    }
  }

  return 'localhost';
}
