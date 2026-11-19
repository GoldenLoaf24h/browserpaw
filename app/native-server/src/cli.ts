#!/usr/bin/env node
import { runCommands } from './command-client';

void runCommands(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
