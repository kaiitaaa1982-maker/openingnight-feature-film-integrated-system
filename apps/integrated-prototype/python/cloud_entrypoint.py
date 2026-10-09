"""Prepare POSIX semaphore directory, then run the private service unprivileged."""
import os
from pathlib import Path

if __name__ == '__main__':
    shared = Path('/dev/shm')
    shared.mkdir(mode=0o1777, parents=True, exist_ok=True)
    os.chmod(shared, 0o1777)
    home = Path('/tmp/workbench-home')
    home.mkdir(mode=0o700, exist_ok=True)
    os.environ['HOME'] = str(home)
    if os.getuid() == 0:
        os.chown(home, 65532, 65532)
        os.setgroups([])
        os.setgid(65532)
        os.setuid(65532)
    os.execvp('python3', ['python3', str(Path(__file__).with_name('cloud_extract_server.py'))])
