import os
import sys

# Ensure logs are written and stdout/stderr exist even when run via pythonw
log_path = os.path.expanduser('~/.browserpaw/decider-service.log')
log_f = open(log_path, 'a', encoding='utf-8', buffering=1)
sys.stdout = log_f
sys.stderr = log_f

os.environ['DECIDER_MODEL'] = os.path.expanduser('~/.browserpaw/models/decider-2b')
os.environ['DECIDER_DEVICE'] = 'cuda'
os.environ['DECIDER_WARMUP'] = '0'

import uvicorn
if __name__ == '__main__':
    uvicorn.run("decider.serve:app", host="127.0.0.1", port=8009, log_level="info")
