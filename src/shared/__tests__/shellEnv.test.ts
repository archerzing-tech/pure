import { describe, expect, it } from 'bun:test';
import { buildShellContext, detectShellPlatform } from '../shellEnv';

describe('detectShellPlatform', () => {
  it('classifies Windows labels without matching darwin', () => {
    expect(detectShellPlatform('windows x86_64')).toBe('windows');
    expect(detectShellPlatform('win32 x64')).toBe('windows');
    expect(detectShellPlatform('Microsoft Windows 11')).toBe('windows');
  });

  it('classifies macOS/Linux labels as posix', () => {
    expect(detectShellPlatform('macOS 15.4 (arm64)')).toBe('posix');
    expect(detectShellPlatform('darwin arm64')).toBe('posix');
    expect(detectShellPlatform('Linux 6.8.0 arm64')).toBe('posix');
  });

  it('returns posix for empty labels', () => {
    expect(detectShellPlatform('')).toBe('posix');
  });
});

describe('buildShellContext', () => {
  it('teaches PowerShell syntax on Windows', () => {
    const ctx = buildShellContext('windows x86_64');
    expect(ctx).toContain('powershell.exe');
    expect(ctx).toContain('-EncodedCommand');
    expect(ctx).toContain('exitCode');
    expect(ctx).toContain('New-Item -ItemType Directory -Force');
    expect(ctx).toContain('mkdir -p');
    expect(ctx).toContain('$LASTEXITCODE');
    expect(ctx).toContain('curl.exe');
    expect(ctx).toContain('Expand-Archive');
    expect(ctx).toContain('Get-ChildItem -Recurse -Filter');
    expect(ctx).toContain('Get-Command');
    expect(ctx).toContain('Get-Content log -Wait');
  });

  it('teaches POSIX sh syntax on macOS', () => {
    const ctx = buildShellContext('macOS 15.4 (arm64)');
    expect(ctx).toContain('sh -c');
    expect(ctx).toContain('mkdir -p');
    expect(ctx).not.toContain('powershell.exe');
  });

  it('returns empty for an empty os label', () => {
    expect(buildShellContext('')).toBe('');
    expect(buildShellContext('   ')).toBe('');
  });
});
