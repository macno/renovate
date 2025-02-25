import { DateTime } from 'luxon';
import { mocked } from '../../../../../test/util';
import * as _packageCache from '../../../../util/cache/package';
import {
  GithubGraphqlResponse,
  GithubHttp,
} from '../../../../util/http/github';
import { AbstractGithubDatasourceCache } from './cache-base';
import type { QueryResponse, StoredItemBase } from './types';

jest.mock('../../../../util/cache/package');
const packageCache = mocked(_packageCache);

interface FetchedItem {
  name: string;
  createdAt: string;
  foo: string;
}

interface StoredItem extends StoredItemBase {
  bar: string;
}

type GraphqlDataResponse = {
  statusCode: 200;
  headers: Record<string, string>;
  body: GithubGraphqlResponse<QueryResponse<FetchedItem>>;
};

type GraphqlResponse = GraphqlDataResponse | Error;

class TestCache extends AbstractGithubDatasourceCache<StoredItem, FetchedItem> {
  cacheNs = 'test-cache';
  graphqlQuery = `query { ... }`;

  coerceFetched({
    name: version,
    createdAt: releaseTimestamp,
    foo: bar,
  }: FetchedItem): StoredItem | null {
    return version === 'invalid' ? null : { version, releaseTimestamp, bar };
  }

  isEquivalent({ bar: x }: StoredItem, { bar: y }: StoredItem): boolean {
    return x === y;
  }
}

function resp(items: FetchedItem[], hasNextPage = false): GraphqlDataResponse {
  return {
    statusCode: 200,
    headers: {},
    body: {
      data: {
        repository: {
          payload: {
            nodes: items,
            pageInfo: {
              hasNextPage,
              endCursor: 'abc',
            },
          },
        },
      },
    },
  };
}

const sortItems = (items: StoredItem[]) =>
  items.sort(({ releaseTimestamp: x }, { releaseTimestamp: y }) =>
    x.localeCompare(y)
  );

describe('modules/datasource/github-releases/cache/cache-base', () => {
  const http = new GithubHttp();
  const httpPostJson = jest.spyOn(GithubHttp.prototype, 'postJson');

  const now = DateTime.local(2022, 6, 15, 18, 30, 30);
  const t1 = now.minus({ days: 3 }).toISO();
  const t2 = now.minus({ days: 2 }).toISO();
  const t3 = now.minus({ days: 1 }).toISO();

  let responses: GraphqlResponse[] = [];

  beforeEach(() => {
    responses = [];
    jest.resetAllMocks();
    jest.spyOn(DateTime, 'now').mockReturnValue(now);
    httpPostJson.mockImplementation(() => {
      const resp = responses.shift();
      return resp instanceof Error
        ? Promise.reject(resp)
        : Promise.resolve(resp);
    });
  });

  it('performs pre-fetch', async () => {
    responses = [
      resp([{ name: 'v3', createdAt: t3, foo: 'ccc' }], true),
      resp([{ name: 'v2', createdAt: t2, foo: 'bbb' }], true),
      resp([{ name: 'v1', createdAt: t1, foo: 'aaa' }]),
    ];
    const cache = new TestCache(http, { resetDeltaMinutes: 0 });

    const res = await cache.getItems({ packageName: 'foo/bar' });

    expect(sortItems(res)).toMatchObject([
      { version: 'v1', bar: 'aaa' },
      { version: 'v2', bar: 'bbb' },
      { version: 'v3', bar: 'ccc' },
    ]);
    expect(packageCache.set).toHaveBeenCalledWith(
      'test-cache',
      'https://api.github.com/:foo:bar',
      {
        createdAt: now.toISO(),
        updatedAt: now.toISO(),
        items: {
          v1: { bar: 'aaa', releaseTimestamp: t1, version: 'v1' },
          v2: { bar: 'bbb', releaseTimestamp: t2, version: 'v2' },
          v3: { bar: 'ccc', releaseTimestamp: t3, version: 'v3' },
        },
      },
      7 * 24 * 60
    );
  });

  it('filters out items being coerced to null', async () => {
    responses = [
      resp([{ name: 'v3', createdAt: t3, foo: 'ccc' }], true),
      resp([{ name: 'invalid', createdAt: t3, foo: 'xxx' }], true),
      resp([{ name: 'v2', createdAt: t2, foo: 'bbb' }], true),
      resp([{ name: 'v1', createdAt: t1, foo: 'aaa' }]),
    ];
    const cache = new TestCache(http, { resetDeltaMinutes: 0 });

    const res = await cache.getItems({ packageName: 'foo/bar' });

    expect(sortItems(res)).toMatchObject([
      { version: 'v1' },
      { version: 'v2' },
      { version: 'v3' },
    ]);
  });

  it('updates items', async () => {
    packageCache.get.mockResolvedValueOnce({
      items: {
        v1: { version: 'v1', releaseTimestamp: t1, bar: 'aaa' },
        v2: { version: 'v2', releaseTimestamp: t2, bar: 'bbb' },
        v3: { version: 'v3', releaseTimestamp: t3, bar: 'ccc' },
      },
      createdAt: t3,
      updatedAt: t3,
    });

    responses = [
      resp([{ name: 'v3', createdAt: t3, foo: 'xxx' }], true),
      resp([{ name: 'v2', createdAt: t2, foo: 'bbb' }], true),
      resp([{ name: 'v1', createdAt: t1, foo: 'aaa' }]),
    ];
    const cache = new TestCache(http, { resetDeltaMinutes: 0 });

    const res = await cache.getItems({ packageName: 'foo/bar' });

    expect(sortItems(res)).toMatchObject([
      { version: 'v1', bar: 'aaa' },
      { version: 'v2', bar: 'bbb' },
      { version: 'v3', bar: 'xxx' },
    ]);
    expect(packageCache.set).toHaveBeenCalledWith(
      'test-cache',
      'https://api.github.com/:foo:bar',
      {
        createdAt: t3,
        updatedAt: now.toISO(),
        items: {
          v1: { bar: 'aaa', releaseTimestamp: t1, version: 'v1' },
          v2: { bar: 'bbb', releaseTimestamp: t2, version: 'v2' },
          v3: { bar: 'xxx', releaseTimestamp: t3, version: 'v3' },
        },
      },
      6 * 24 * 60
    );
  });

  it('stops updating once stability period have passed', async () => {
    packageCache.get.mockResolvedValueOnce({
      items: {
        v1: { version: 'v1', releaseTimestamp: t1, bar: 'aaa' },
        v2: { version: 'v2', releaseTimestamp: t2, bar: 'bbb' },
        v3: { version: 'v3', releaseTimestamp: t3, bar: 'ccc' },
      },
      createdAt: t3,
      updatedAt: t3,
    });
    responses = [
      resp([{ name: 'v3', createdAt: t3, foo: 'zzz' }], true),
      resp([{ name: 'v2', createdAt: t2, foo: 'yyy' }], true),
      resp([{ name: 'v1', createdAt: t1, foo: 'xxx' }]),
    ];
    const cache = new TestCache(http, { unstableDays: 1.5 });

    const res = await cache.getItems({ packageName: 'foo/bar' });

    expect(sortItems(res)).toMatchObject([
      { version: 'v1', bar: 'aaa' },
      { version: 'v2', bar: 'bbb' },
      { version: 'v3', bar: 'zzz' },
    ]);
  });

  it('removes deleted items from cache', async () => {
    packageCache.get.mockResolvedValueOnce({
      items: {
        v1: { version: 'v1', releaseTimestamp: t1, bar: 'aaa' },
        v2: { version: 'v2', releaseTimestamp: t2, bar: 'bbb' },
        v3: { version: 'v3', releaseTimestamp: t3, bar: 'ccc' },
      },
      createdAt: t3,
      updatedAt: t3,
    });
    responses = [
      resp([{ name: 'v3', createdAt: t3, foo: 'ccc' }], true),
      resp([{ name: 'v1', createdAt: t1, foo: 'aaa' }]),
    ];
    const cache = new TestCache(http, { resetDeltaMinutes: 0 });

    const res = await cache.getItems({ packageName: 'foo/bar' });

    expect(sortItems(res)).toMatchObject([
      { version: 'v1', bar: 'aaa' },
      { version: 'v3', bar: 'ccc' },
    ]);
  });

  it('returns cached values on server errors', async () => {
    packageCache.get.mockResolvedValueOnce({
      items: {
        v1: { version: 'v1', releaseTimestamp: t1, bar: 'aaa' },
        v2: { version: 'v2', releaseTimestamp: t2, bar: 'bbb' },
        v3: { version: 'v3', releaseTimestamp: t3, bar: 'ccc' },
      },
      createdAt: t3,
      updatedAt: t3,
    });
    responses = [
      resp([{ name: 'v3', createdAt: t3, foo: 'zzz' }], true),
      new Error('Unknown error'),
      resp([{ name: 'v1', createdAt: t1, foo: 'xxx' }]),
    ];
    const cache = new TestCache(http, { resetDeltaMinutes: 0 });

    const res = await cache.getItems({ packageName: 'foo/bar' });

    expect(sortItems(res)).toMatchObject([
      { version: 'v1', bar: 'aaa' },
      { version: 'v2', bar: 'bbb' },
      { version: 'v3', bar: 'ccc' },
    ]);
  });
});
