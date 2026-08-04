import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  loadReviewAccessProfile,
  validateReviewAccessPath,
} from './review-access-profile.js';

function writeProfileFile(value: unknown, mode = 0o600): string {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'rbclaw-review-profile-'),
  );
  const filePath = path.join(tempDir, 'profiles.json');
  fs.writeFileSync(filePath, JSON.stringify(value), { mode });
  fs.chmodSync(filePath, mode);
  return filePath;
}

describe('review access profiles', () => {
  it('loads a strict room-independent profile', () => {
    const filePath = writeProfileFile({
      version: 1,
      profiles: {
        'egot-web-review': {
          environments: {
            production: {
              web: {
                baseUrl: 'https://example.com',
                paths: ['/', '/health'],
                allowedOrigins: ['https://cdn.example.com'],
              },
              remote: {
                sshProfile: 'egot',
                allowedRoots: ['/etc/nginx', '/var/log/nginx'],
                serviceUnits: ['nginx'],
                journalUnits: ['nginx'],
                logFiles: [
                  { id: 'nginx-error', path: '/var/log/nginx/error.log' },
                ],
                configFiles: [
                  { id: 'nginx-main', path: '/etc/nginx/nginx.conf' },
                ],
              },
            },
          },
        },
      },
    });

    expect(
      loadReviewAccessProfile('egot-web-review', {
        REVIEW_ACCESS_PROFILES_FILE: filePath,
      }).environments.production,
    ).toMatchObject({
      web: {
        baseUrl: 'https://example.com',
        paths: ['/', '/health'],
        allowedOrigins: ['https://cdn.example.com'],
      },
      remote: { sshProfile: 'egot', serviceUnits: ['nginx'] },
    });
  });

  it('rejects world-readable profiles and denied paths', () => {
    const filePath = writeProfileFile({ version: 1, profiles: {} }, 0o644);
    expect(() =>
      loadReviewAccessProfile('egot-web-review', {
        REVIEW_ACCESS_PROFILES_FILE: filePath,
      }),
    ).toThrow('must not be group/world accessible');
    expect(() => validateReviewAccessPath('/srv/app/.env', 'config')).toThrow(
      'denied secret path',
    );
    expect(() =>
      validateReviewAccessPath('/srv/app/../.env', 'config'),
    ).toThrow();
    expect(() => validateReviewAccessPath('/srv/app/*.conf', 'config')).toThrow(
      'forbidden path syntax',
    );
  });

  it('rejects configured files outside allowed roots', () => {
    const filePath = writeProfileFile({
      version: 1,
      profiles: {
        unsafe: {
          environments: {
            production: {
              remote: {
                sshProfile: 'egot',
                allowedRoots: ['/etc/nginx'],
                configFiles: [{ id: 'passwd', path: '/etc/passwd' }],
              },
            },
          },
        },
      },
    });
    expect(() =>
      loadReviewAccessProfile('unsafe', {
        REVIEW_ACCESS_PROFILES_FILE: filePath,
      }),
    ).toThrow('outside allowedRoots');
  });

  it('rejects configured GET paths with common side effects', () => {
    const filePath = writeProfileFile({
      version: 1,
      profiles: {
        unsafe: {
          environments: {
            production: {
              web: {
                baseUrl: 'https://example.com',
                paths: ['/logout'],
              },
            },
          },
        },
      },
    });
    expect(() =>
      loadReviewAccessProfile('unsafe', {
        REVIEW_ACCESS_PROFILES_FILE: filePath,
      }),
    ).toThrow('denied side-effect path');
  });
});
