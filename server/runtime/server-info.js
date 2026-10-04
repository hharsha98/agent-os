// The port this server is really listening on. The desktop app starts the
// server with PORT=0 (let the operating system pick a free port), so the real
// number only exists after listen() finishes. server/index.js records it here
// once, and anything that must tell the outside world "call me back at
// localhost:<port>" (the OpenRouter sign-in) reads it from here.
let boundPort = 0;

export function setServerPort(port) {
  const value = Number(port);
  boundPort = Number.isInteger(value) && value > 0 && value <= 65535 ? value : 0;
}

// 0 means "not known yet" (the server has not finished starting).
export function getServerPort() {
  return boundPort;
}
