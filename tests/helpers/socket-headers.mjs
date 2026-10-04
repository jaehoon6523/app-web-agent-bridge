// A TCP data event is a chunk, not a complete HTTP response header.
export function readHttpHeaders(socket, { timeoutMs = 5000, maxBytes = 16 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let received = Buffer.alloc(0), timer, settled = false;
    const finish = (error, headers) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('data', data);
      socket.off('error', failed);
      socket.off('end', ended);
      socket.off('close', ended);
      if (error) reject(error);
      else resolve(headers);
    };
    const failed = error => finish(error);
    const ended = () => finish(Object.assign(new Error('Socket closed before complete HTTP headers'), { code:'HTTP_HEADERS_INCOMPLETE' }));
    const data = chunk => {
      received = Buffer.concat([received, chunk]);
      const end = received.indexOf('\r\n\r\n'), size = end < 0 ? received.length : end + 4;
      if (size > maxBytes) finish(Object.assign(new Error('HTTP headers exceed observation limit'), { code:'HTTP_HEADERS_TOO_LARGE' }));
      else if (end >= 0) finish(null, received.subarray(0, size));
    };
    if (socket.destroyed || socket.readableEnded) { ended(); return; }
    socket.on('data', data);
    socket.once('error', failed);
    socket.once('end', ended);
    socket.once('close', ended);
    timer = setTimeout(() => finish(Object.assign(new Error('HTTP headers did not complete before observation deadline'), { code:'HTTP_HEADERS_DEADLINE' })), timeoutMs);
  });
}
