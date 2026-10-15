import os
import sys

# Resolve the BrowserPaw home the same way the native manager does.
bp_home = os.environ.get('BROWSERPAW_HOME') or os.path.expanduser('~/.browserpaw')

# Ensure logs are written and stdout/stderr exist even when run via pythonw
log_path = os.path.join(bp_home, 'decider-service.log')
log_f = open(log_path, 'a', encoding='utf-8', buffering=1)
sys.stdout = log_f
sys.stderr = log_f

os.environ['DECIDER_MODEL'] = os.path.join(bp_home, 'models', 'decider-2b')
# Only default the device when the caller did not pick one.
os.environ.setdefault('DECIDER_DEVICE', 'auto')
os.environ['DECIDER_WARMUP'] = '0'

import uvicorn
if __name__ == '__main__':
    uvicorn.run("decider.serve:app", host="127.0.0.1", port=8009, log_level="info")
