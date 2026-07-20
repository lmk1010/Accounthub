import assert from 'node:assert/strict';
import test from 'node:test';

import { sanitizeSqlParams } from '../src/config/database.js';

test('sanitizes undefined SQL bind params for arrays and named placeholders', () => {
    assert.deepEqual(
        sanitizeSqlParams(['provider-1', undefined, ['gpt-5.5', undefined]]),
        ['provider-1', null, ['gpt-5.5', null]]
    );

    assert.deepEqual(
        sanitizeSqlParams({
            providerUuid: 'provider-1',
            providerType: undefined,
            nested: {
                model: 'gpt-5.5',
                statusCode: undefined
            }
        }),
        {
            providerUuid: 'provider-1',
            providerType: null,
            nested: {
                model: 'gpt-5.5',
                statusCode: null
            }
        }
    );
});
