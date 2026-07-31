// src/termcolors.ts
// ANSI escape codes for consistent terminal styling.

export const C = {
  reset:   '\x1b[0m',
  dim:     '\x1b[2m',
  bold:    '\x1b[1m',
  red:     '\x1b[31m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  blue:    '\x1b[34m',
  magenta: '\x1b[35m',
  cyan:    '\x1b[36m',
  white:   '\x1b[37m',
  gray:    '\x1b[90m',
} as const;

export const dim    = (s: string) => `${C.dim}${s}${C.reset}`;
export const bold   = (s: string) => `${C.bold}${s}${C.reset}`;
export const red    = (s: string) => `${C.red}${s}${C.reset}`;
export const green  = (s: string) => `${C.green}${s}${C.reset}`;
export const yellow = (s: string) => `${C.yellow}${s}${C.reset}`;
export const blue   = (s: string) => `${C.blue}${s}${C.reset}`;
export const cyan   = (s: string) => `${C.cyan}${s}${C.reset}`;
export const gray   = (s: string) => `${C.gray}${s}${C.reset}`;
export const magenta = (s: string) => `${C.magenta}${s}${C.reset}`;
export const purple     = (s: string) => `\x1b[38;5;141m${s}\x1b[0m`;
export const frameGray  = (s: string) => `\x1b[38;5;240m${s}\x1b[0m`;
export const lightGray  = (s: string) => `\x1b[38;5;245m${s}\x1b[0m`;
