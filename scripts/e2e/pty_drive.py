#!/usr/bin/env python3
"""Runs a command on a pseudo-terminal and answers its prompts from a script, like a person would.

  SCRIPT='[["expected prompt text", "answer"], ...]' pty_drive.py <cwd> <command> [args...]

Each step waits until its text appears, then types the answer. Prints the whole session and exits
non-zero when the command fails, when a prompt never appeared, or after 120 seconds.
"""
import json, os, pty, re, select, sys, time

steps = json.loads(os.environ["SCRIPT"])
cwd, cmd = sys.argv[1], sys.argv[2:]
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.execvp(cmd[0], cmd)

out, buf, i = "", "", 0
deadline = time.time() + 120
exited = None
while time.time() < deadline and exited is None:
    ready, _, _ = select.select([fd], [], [], 0.5)
    if ready:
        try:
            data = os.read(fd, 4096).decode("utf-8", "replace")
        except OSError:
            data = ""
        if data:
            out += data
            buf += data
            if i < len(steps) and steps[i][0] in buf:
                time.sleep(0.15)
                os.write(fd, (steps[i][1] + "\n").encode())
                buf, i = "", i + 1
            continue
    done, status = os.waitpid(pid, os.WNOHANG)
    if done:
        exited = os.waitstatus_to_exitcode(status)
if exited is None:
    os.kill(pid, 9)
    os.waitpid(pid, 0)
    exited = -9

print(re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", out).replace("\r", ""))
print(f"--- answered {i} of {len(steps)} prompts; exit status {exited}")
sys.exit(0 if exited == 0 and i == len(steps) else 1)
