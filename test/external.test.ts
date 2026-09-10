import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  recogniseExternalDocument, linkTargetOf, externalFileName,
} from '../dist/lib/external.js';

describe('external document recognition', () => {
  test('recognises Google Slides, Docs and Sheets', () => {
    const cases: Array<[string, string, string[]]> = [
      [
        'https://docs.google.com/presentation/d/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/edit?usp=sharing',
        'presentation',
        ['txt', 'pdf', 'pptx'],
      ],
      ['https://docs.google.com/document/d/1abcdefghijABCDEF/edit', 'document', ['txt', 'pdf', 'docx']],
      ['https://docs.google.com/spreadsheets/d/1abcdefghijABCDEF/edit#gid=0', 'spreadsheet', ['csv', 'pdf', 'xlsx']],
    ];
    for (const [url, kind, formats] of cases) {
      const doc = recogniseExternalDocument(url);
      assert.ok(doc, `${url} should be recognised`);
      assert.equal(doc.kind, kind);
      assert.deepEqual(doc.formats, formats);
    }
  });

  test('builds the documented export URL', () => {
    const doc = recogniseExternalDocument(
      'https://docs.google.com/presentation/d/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/edit?usp=sharing',
    );
    assert.equal(
      doc?.exportUrl('pdf'),
      'https://docs.google.com/presentation/d/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/export/pdf',
    );
  });

  test('puts the cheapest-to-read format first', () => {
    // The default format is what an unqualified read will fetch, and txt costs
    // a fraction of the tokens a rendered PDF does.
    assert.equal(recogniseExternalDocument('https://docs.google.com/presentation/d/1abcdefghij/edit')?.formats[0], 'txt');
    assert.equal(recogniseExternalDocument('https://docs.google.com/spreadsheets/d/1abcdefghij/edit')?.formats[0], 'csv');
  });

  test('recognises a Drive-hosted file', () => {
    const doc = recogniseExternalDocument('https://drive.google.com/file/d/1abcdefghijABC/view');
    assert.equal(doc?.kind, 'file');
    assert.match(doc?.exportUrl('pdf') ?? '', /uc\?export=download&id=1abcdefghijABC/);
  });

  test('rejects everything not on the allowlist', () => {
    // The URL comes out of Blackboard content and is written by a third party.
    // Fetching arbitrary hosts would be a request-forgery and exfiltration path,
    // so anything unrecognised must return null rather than being attempted.
    for (const url of [
      'https://evil.example/presentation/d/1abcdefghij/edit',
      'http://docs.google.com/presentation/d/1abcdefghij/edit', // not https
      'https://docs.google.example.com/presentation/d/1abcdefghij/edit',
      'https://docs.google.com/../etc/passwd',
      'https://links.example.edu/',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'not a url',
      '',
    ]) {
      assert.equal(recogniseExternalDocument(url), null, `${url} must be rejected`);
    }
  });

  test('rejects a Google URL with no document id', () => {
    assert.equal(recogniseExternalDocument('https://docs.google.com/presentation/'), null);
    assert.equal(recogniseExternalDocument('https://docs.google.com/presentation/d/short'), null);
  });
});

describe('link target extraction', () => {
  test('reads the url out of an external-link content item', () => {
    const url = linkTargetOf('resource/x-bb-externallink', {
      'resource/x-bb-externallink': { url: 'https://links.example.edu/' },
    });
    assert.equal(url, 'https://links.example.edu/');
  });

  test('returns undefined for items with no link', () => {
    assert.equal(linkTargetOf('resource/x-bb-folder', { 'resource/x-bb-folder': { isFolder: true } }), undefined);
    assert.equal(linkTargetOf(undefined, undefined), undefined);
    assert.equal(linkTargetOf('resource/x-bb-file', {}), undefined);
  });
});

describe('external filenames', () => {
  test('uses the content item title when available', () => {
    const doc = recogniseExternalDocument('https://docs.google.com/presentation/d/1abcdefghij/edit')!;
    assert.equal(externalFileName('Session - 04', doc, 'txt'), 'Session - 04.txt');
  });

  test('falls back to the document id', () => {
    const doc = recogniseExternalDocument('https://docs.google.com/presentation/d/1abcdefghij/edit')!;
    assert.match(externalFileName(undefined, doc, 'pdf'), /^presentation-1abcdefghij\.pdf$/);
  });
});
