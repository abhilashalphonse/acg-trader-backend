"""Explicit on-demand chain only. No scheduler installation."""
import subprocess,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
subprocess.run([sys.executable,str(ROOT/'work/state01_capture.py'),'--verify-only'],cwd=ROOT,check=True)
subprocess.run([sys.executable,str(ROOT/'work/accept01_run.py')],cwd=ROOT,check=True)
subprocess.run([sys.executable,str(ROOT/'work/state01_capture.py')],cwd=ROOT,check=True)
