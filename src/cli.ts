#!/usr/bin/env node
import { runCli } from './cli/run.ts'

const exitCode = await runCli()
if (exitCode !== undefined) process.exitCode = exitCode
