#!/usr/bin/env node
/**
 * HTTPS front door for phones on the office Wi-Fi.
 *
 * Phone browsers only allow the live camera inside a web page over HTTPS. This serves
 * https://<wifi-ip>:3443 with a self-signed certificate and forwards every request (including
 * Next's dev websocket) to the normal frontend on http://127.0.0.1:3000. The dashboard on
 * http://localhost:3000 is unchanged.
 *
 * The certificate is self-signed, so each phone shows a one-time "connection not private"
 * warning. It is (re)generated with openssl whenever this PC's Wi-Fi IP isn't covered by it.
 *
 *   node scripts/lan-https.mjs        (env: LAN_HTTPS_PORT=3443, LAN_HTTPS_TARGET_PORT=3000)
 */

import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.LAN_HTTPS_PORT || 3443);
const TARGET_PORT = Number(process.env.LAN_HTTPS_TARGET_PORT || 3000);
const TARGET_HOST = '127.0.0.1';

const certDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.certs');
const keyFile = path.join(certDir, 'lan-key.pem');
const certFile = path.join(certDir, 'lan-cert.pem');

function lanIps() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.'))
    .map((a) => a.address);
}

function findOpenssl() {
  const candidates = [
    'openssl',
    'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe',
    'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
    'C:\\Program Files (x86)\\Git\\mingw64\\bin\\openssl.exe',
  ];
  for (const c of candidates) {
    try {
      execFileSync(c, ['version'], { stdio: 'ignore' });
      return c;
    } catch {
      /* try next */
    }
  }
  return null;
}

function certCovers(ips) {
  if (!fs.existsSync(keyFile) || !fs.existsSync(certFile)) return false;
  try {
    const cert = new X509Certificate(fs.readFileSync(certFile));
    const san = cert.subjectAltName || '';
    const fresh = new Date(cert.validTo).getTime() - Date.now() > 7 * 24 * 3600 * 1000;
    return fresh && ips.every((ip) => san.includes(`IP Address:${ip}`));
  } catch {
    return false;
  }
}

function ensureCert(ips) {
  if (certCovers(ips)) return;
  const openssl = findOpenssl();
  if (!openssl) {
    console.error('openssl not found. Install Git for Windows (it includes openssl) or add openssl to PATH.');
    process.exit(1);
  }
  fs.mkdirSync(certDir, { recursive: true });
  const san = ['DNS:localhost', 'IP:127.0.0.1', ...ips.map((ip) => `IP:${ip}`)].join(',');
  execFileSync(
    openssl,
    [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '825',
      '-keyout', keyFile, '-out', certFile,
      '-subj', '/CN=WorkSight office Wi-Fi',
      '-addext', `subjectAltName=${san}`,
      '-addext', 'extendedKeyUsage=serverAuth',
    ],
    { stdio: 'ignore' }
  );
  console.log(`Created a self-signed certificate for ${ips.join(', ')}`);
}

const ips = lanIps();
ensureCert(ips);

// Connection log (console + frontend/logs/lan-https.log) to tell "phone never arrived" from
// "phone refused the certificate". Query strings are dropped so enrolment tokens are never logged.
const logFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'logs', 'lan-https.log');
fs.mkdirSync(path.dirname(logFile), { recursive: true });
function log(line) {
  const entry = `${new Date().toISOString()} ${line}`;
  console.log(entry);
  fs.appendFile(logFile, entry + '\n', () => {});
}
const peer = (socket) => String(socket?.remoteAddress || '?').replace(/^::ffff:/, '');

const server = https.createServer({ key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) }, (req, res) => {
  const pathOnly = (req.url || '/').split('?')[0];
  if (!pathOnly.startsWith('/_next/')) {
    res.on('finish', () => log(`${peer(req.socket)} ${req.method} ${pathOnly} -> ${res.statusCode}`));
  }
  const headers = {
    ...req.headers,
    'x-forwarded-proto': 'https',
    'x-forwarded-host': req.headers.host || '',
    'x-forwarded-for': req.socket.remoteAddress || '',
  };
  const upstream = http.request(
    { host: TARGET_HOST, port: TARGET_PORT, method: req.method, path: req.url, headers },
    (upRes) => {
      res.writeHead(upRes.statusCode || 502, upRes.headers);
      upRes.pipe(res);
    }
  );
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`WorkSight frontend is not running on port ${TARGET_PORT}. Start it, then reload this page.`);
  });
  req.pipe(upstream);
});

// Every new connection, and whether its secure handshake completed: pinpoints where a phone gets stuck.
server.on('connection', (socket) => {
  const who = peer(socket);
  if (who === '127.0.0.1' || ips.includes(who)) return;
  log(`${who} connected`);
  socket.once('close', (hadError) => log(`${who} disconnected${hadError ? ' with an error' : ''}`));
});
server.on('secureConnection', (tls) => {
  const who = peer(tls);
  if (who !== '127.0.0.1' && !ips.includes(who)) log(`${who} accepted the certificate (secure connection ready)`);
});

// A phone that reached us but would not accept the certificate shows up here.
server.on('tlsClientError', (err, socket) => {
  log(`${peer(socket)} TLS handshake refused (${err.code || err.message}) - usually the phone rejected the office certificate`);
});

// Websockets (Next's dev live-reload): replay the handshake upstream, then splice the sockets.
server.on('upgrade', (req, socket, head) => {
  const upstream = net.connect(TARGET_PORT, TARGET_HOST, () => {
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`WorkSight phone HTTPS -> http://${TARGET_HOST}:${TARGET_PORT}`);
  for (const ip of ips) console.log(`  https://${ip}:${PORT}`);
  console.log('Phones show a one-time certificate warning: Advanced > Proceed (Android) or Show Details > visit this website (iPhone).');
});
