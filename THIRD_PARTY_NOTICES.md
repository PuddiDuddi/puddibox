# Third-party notices

## pisinger/wslc-agent-sandbox

- Source: https://github.com/pisinger/wslc-agent-sandbox
- License: MIT
- Used in puddibox:
  - The network design: the agent container is on a `wslc network create --internal` network
    with no route out, and a Squid sidecar proxy is the only exit.
  - `proxy/squid.conf` is derived from `proxy/squid.conf` in that repository: the CONNECT-only,
    port-443-only allowlist rules and the `/run/squid/allowed_domains.txt` allowlist file.

```
MIT License

Copyright (c) 2026 Pit Singert

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Software installed in the images at build time

The images download these at build time. They are not part of this repository and keep their
own licenses: Debian, Alpine Linux, Squid, uv, Python (python-build-standalone), Claude Code.
