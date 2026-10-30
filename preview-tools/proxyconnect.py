#!/usr/bin/env python3
"""ProxyCommand helper: CONNECT through the egress HTTP proxy (from env),
then relay stdin/stdout <-> socket. Usage: proxyconnect.py <host> <port>"""
import base64
import os
import socket
import sys
import threading
from urllib.parse import urlparse


def main() -> int:
    host, port = sys.argv[1], int(sys.argv[2])
    raw = (
        os.environ.get("https_proxy")
        or os.environ.get("HTTPS_PROXY")
        or os.environ.get("http_proxy")
        or os.environ.get("HTTP_PROXY")
    )
    if not raw:
        print("no proxy env set", file=sys.stderr)
        return 1
    p = urlparse(raw)
    sock = socket.create_connection((p.hostname, p.port or 3128))
    lines = [f"CONNECT {host}:{port} HTTP/1.1", f"Host: {host}:{port}"]
    if p.username:
        cred = base64.b64encode(
            f"{p.username}:{p.password or ''}".encode()
        ).decode()
        lines.append(f"Proxy-Authorization: Basic {cred}")
    sock.sendall(("\r\n".join(lines) + "\r\n\r\n").encode())
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = sock.recv(4096)
        if not chunk:
            print("proxy closed during CONNECT", file=sys.stderr)
            return 1
        buf += chunk
    status = buf.split(b"\r\n", 1)[0]
    if b" 200 " not in status:
        print(f"CONNECT failed: {status!r}", file=sys.stderr)
        return 1

    def stdin_to_sock() -> None:
        try:
            while True:
                data = os.read(0, 65536)
                if not data:
                    break
                sock.sendall(data)
        except OSError:
            pass
        try:
            sock.shutdown(socket.SHUT_WR)
        except OSError:
            pass

    t = threading.Thread(target=stdin_to_sock, daemon=True)
    t.start()
    try:
        while True:
            data = sock.recv(65536)
            if not data:
                break
            os.write(1, data)
    except OSError:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
