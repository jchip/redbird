'use strict';

const redbird = require('..');
const { asyncVerify, runFinally } = require('run-verify');
const needle = require('needle');
const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const hash = require('object-hash');

describe('On-the-fly compression', function() {
  const TEMP_DIR = path.join(os.tmpdir(), 'redbird-compressed');
  const testFilePath = path.join(__dirname, 'temp-test-file.js');
  const testFileContent = 'console.log("Test file for compression"); // This is a test file\n'.repeat(
    100
  );
  const FIVE_MINUTES = 5 * 60 * 1000;

  before(async () => {
    // Create a test file without pre-compressed versions
    await fs.promises.writeFile(testFilePath, testFileContent);
  });

  after(async () => {
    // Clean up test files
    try {
      await fs.promises.unlink(testFilePath);
    } catch (err) {
      // Ignore if file doesn't exist
    }

    // Clean up temp directory
    try {
      const files = await fs.promises.readdir(TEMP_DIR);
      for (const file of files) {
        await fs.promises.unlink(path.join(TEMP_DIR, file));
      }
    } catch (err) {
      // Ignore if directory doesn't exist
    }
  });

  function getTempFilename(filename, encoding) {
    const fileHash = hash(filename);
    const ext = encoding === 'br' ? 'br' : 'gz';
    return path.join(TEMP_DIR, `${fileHash}.${ext}`);
  }

  it('should compress files on-the-fly when no pre-compressed version exists', async () => {
    let proxy;

    return asyncVerify(
      () => {
        proxy = redbird({
          bunyan: false,
          port: 18999
        });

        proxy.register({
          src: 'localhost/test',
          target: `file://${testFilePath}`
        });
      },

      async () => {
        // Test gzip compression
        const gzipResponse = await needle('get', 'http://localhost:18999/test', {
          headers: { 'accept-encoding': 'gzip, deflate' }
        });

        expect(gzipResponse.statusCode).to.equal(200);
        expect(gzipResponse.headers['content-encoding']).to.equal('gzip');
        expect(gzipResponse.headers['content-type']).to.equal('application/javascript');

        // Verify the content can be decompressed correctly
        const decompressedGzip = zlib.gunzipSync(gzipResponse.raw).toString();
        expect(decompressedGzip).to.equal(testFileContent);

        // Test brotli compression
        const brotliResponse = await needle('get', 'http://localhost:18999/test', {
          headers: { 'accept-encoding': 'br, gzip, deflate' }
        });

        expect(brotliResponse.statusCode).to.equal(200);
        expect(brotliResponse.headers['content-encoding']).to.equal('br');
        expect(brotliResponse.headers['content-type']).to.equal('application/javascript');

        // Verify the content can be decompressed correctly
        const decompressedBrotli = zlib.brotliDecompressSync(brotliResponse.raw).toString();
        expect(decompressedBrotli).to.equal(testFileContent);
      },

      runFinally(() => proxy && proxy.close())
    );
  });

  it('should save compressed files to temp directory', async () => {
    let proxy;
    const gzipTempPath = getTempFilename(testFilePath, 'gz');
    const brotliTempPath = getTempFilename(testFilePath, 'br');

    return asyncVerify(
      () => {
        proxy = redbird({
          bunyan: false,
          port: 18999
        });

        proxy.register({
          src: 'localhost/test',
          target: `file://${testFilePath}`
        });
      },

      async () => {
        // Make requests to trigger compression
        await needle('get', 'http://localhost:18999/test', {
          headers: { 'accept-encoding': 'gzip, deflate' }
        });

        await needle('get', 'http://localhost:18999/test', {
          headers: { 'accept-encoding': 'br, gzip, deflate' }
        });

        // Check if compressed files were created in temp directory
        const gzipExists = await fs.promises
          .access(gzipTempPath)
          .then(() => true)
          .catch(() => false);
        const brotliExists = await fs.promises
          .access(brotliTempPath)
          .then(() => true)
          .catch(() => false);

        expect(gzipExists).to.be.true;
        expect(brotliExists).to.be.true;

        // Verify the compressed files contain the correct data
        const gzipFile = await fs.promises.readFile(gzipTempPath);
        const brotliFile = await fs.promises.readFile(brotliTempPath);

        const decompressedGzip = zlib.gunzipSync(gzipFile).toString();
        const decompressedBrotli = zlib.brotliDecompressSync(brotliFile).toString();

        expect(decompressedGzip).to.equal(testFileContent);
        expect(decompressedBrotli).to.equal(testFileContent);
      },

      runFinally(() => proxy && proxy.close())
    );
  });

  it('should use cached compressed files from temp directory when available', async () => {
    let proxy;
    const gzipTempPath = getTempFilename(testFilePath, 'gz');

    return asyncVerify(
      () => {
        proxy = redbird({
          bunyan: false,
          port: 18999
        });

        proxy.register({
          src: 'localhost/test',
          target: `file://${testFilePath}`
        });
      },

      async () => {
        // First request - should create compressed file
        const firstResponse = await needle('get', 'http://localhost:18999/test', {
          headers: { 'accept-encoding': 'gzip, deflate' }
        });

        expect(firstResponse.statusCode).to.equal(200);
        expect(firstResponse.headers['content-encoding']).to.equal('gzip');

        // Get the modification time of the temp file
        const tempStat = await fs.promises.stat(gzipTempPath);
        const tempMtime = tempStat.mtime;

        // Second request - should use cached compressed file
        const secondResponse = await needle('get', 'http://localhost:18999/test', {
          headers: { 'accept-encoding': 'gzip, deflate' }
        });

        expect(secondResponse.statusCode).to.equal(200);
        expect(secondResponse.headers['content-encoding']).to.equal('gzip');

        // Verify both responses have the same content
        expect(firstResponse.raw).to.deep.equal(secondResponse.raw);

        // Verify temp file wasn't modified (cache was used)
        const tempStatAfter = await fs.promises.stat(gzipTempPath);
        expect(tempStatAfter.mtime.getTime()).to.equal(tempMtime.getTime());
      },

      runFinally(() => proxy && proxy.close())
    );
  });

  it('should regenerate compressed files when original is newer', async () => {
    let proxy;
    const gzipTempPath = getTempFilename(testFilePath, 'gz');
    const newContent = 'console.log("Updated test file"); // This is an updated test file\n'.repeat(
      50
    );

    return asyncVerify(
      () => {
        proxy = redbird({
          bunyan: false,
          port: 18999
        });

        proxy.register({
          src: 'localhost/test',
          target: `file://${testFilePath}`
        });
      },

      async () => {
        // First request - create initial compressed file
        const firstResponse = await needle('get', 'http://localhost:18999/test', {
          headers: { 'accept-encoding': 'gzip, deflate' }
        });

        expect(firstResponse.statusCode).to.equal(200);
        expect(firstResponse.headers['content-encoding']).to.equal('gzip');

        // Wait a moment to ensure different timestamps
        await new Promise(resolve => setTimeout(resolve, 100));

        // Update the original file
        await fs.promises.writeFile(testFilePath, newContent);

        // Second request - should regenerate compressed file
        const secondResponse = await needle('get', 'http://localhost:18999/test', {
          headers: { 'accept-encoding': 'gzip, deflate' }
        });

        expect(secondResponse.statusCode).to.equal(200);
        expect(secondResponse.headers['content-encoding']).to.equal('gzip');

        // Verify the content is different and reflects the updated file
        const decompressedSecond = zlib.gunzipSync(secondResponse.raw).toString();
        expect(decompressedSecond).to.equal(newContent);
        expect(decompressedSecond).to.not.equal(testFileContent);

        // Verify responses are different
        expect(firstResponse.raw).to.not.deep.equal(secondResponse.raw);

        // Restore original content for other tests
        await fs.promises.writeFile(testFilePath, testFileContent);
      },

      runFinally(() => proxy && proxy.close())
    );
  });

  it('should expire in-memory cache after 5 minutes and fall back to temp files', async () => {
    let proxy;
    const gzipTempPath = getTempFilename(testFilePath, 'gz');

    return asyncVerify(
      () => {
        proxy = redbird({
          bunyan: false,
          port: 18999
        });

        proxy.register({
          src: 'localhost/test',
          target: `file://${testFilePath}`
        });
      },

      async () => {
        // First request - should create compressed file in memory and temp
        const firstResponse = await needle('get', 'http://localhost:18999/test', {
          headers: { 'accept-encoding': 'gzip, deflate' }
        });

        expect(firstResponse.statusCode).to.equal(200);
        expect(firstResponse.headers['content-encoding']).to.equal('gzip');

        // Verify temp file was created
        const tempExists = await fs.promises
          .access(gzipTempPath)
          .then(() => true)
          .catch(() => false);
        expect(tempExists).to.be.true;

        // Access the target and manually expire the cache by setting an old timestamp
        const routes = proxy.routing['localhost'];
        const route = routes && routes.find(r => r.path === '/');
        const target = route && route.urls && route.urls[0];
        const cacheKey = `${testFilePath}.gz`;

        if (target && target.cache && target.cache[cacheKey]) {
          // Set cache timestamp to 6 minutes ago (expired)
          target.cache[cacheKey].timeStamp = Date.now() - (FIVE_MINUTES + 60000);
        }

        // Second request - should detect expired cache and fall back to temp file
        const secondResponse = await needle('get', 'http://localhost:18999/test', {
          headers: { 'accept-encoding': 'gzip, deflate' }
        });

        expect(secondResponse.statusCode).to.equal(200);
        expect(secondResponse.headers['content-encoding']).to.equal('gzip');

        // Verify both responses have the same content (temp file was used)
        expect(firstResponse.raw).to.deep.equal(secondResponse.raw);

        // Verify new cache entry was created with recent timestamp
        if (target && target.cache && target.cache[cacheKey]) {
          const cacheAge = Date.now() - target.cache[cacheKey].timeStamp;
          expect(cacheAge).to.be.lessThan(1000); // Should be very recent (< 1 second)
        }
      },

      runFinally(() => proxy && proxy.close())
    );
  });

  it('should handle compression errors gracefully', async () => {
    let proxy;
    const nonExistentFile = path.join(__dirname, 'non-existent-file.js');

    return asyncVerify(
      () => {
        proxy = redbird({
          bunyan: false,
          port: 18999
        });

        proxy.register({
          src: 'localhost/test',
          target: `file://${nonExistentFile}`
        });
      },

      async () => {
        // Request non-existent file
        const response = await needle('get', 'http://localhost:18999/test', {
          headers: { 'accept-encoding': 'gzip, deflate' }
        });

        expect(response.statusCode).to.equal(404);
      },

      runFinally(() => proxy && proxy.close())
    );
  });

  it('should work with directory targets and index files', async () => {
    let proxy;
    const testDir = path.join(__dirname, 'test-dir');
    const indexFile = path.join(testDir, 'index.html');
    const indexContent = '<html><body>Test index page</body></html>';

    return asyncVerify(
      async () => {
        // Create test directory and index file
        await fs.promises.mkdir(testDir, { recursive: true });
        await fs.promises.writeFile(indexFile, indexContent);

        proxy = redbird({
          bunyan: false,
          port: 18999
        });

        proxy.register({
          src: 'localhost/test',
          target: `file://${testDir}`
        });
      },

      async () => {
        // Request directory with compression
        const response = await needle('get', 'http://localhost:18999/test/', {
          headers: { 'accept-encoding': 'gzip, deflate' }
        });

        expect(response.statusCode).to.equal(200);
        expect(response.headers['content-encoding']).to.equal('gzip');
        expect(response.headers['content-type']).to.equal('text/html');

        // Verify the content can be decompressed correctly
        const decompressed = zlib.gunzipSync(response.raw).toString();
        expect(decompressed).to.equal(indexContent);
      },

      runFinally(() => proxy && proxy.close()),
      runFinally(async () => {
        // Clean up test directory
        try {
          await fs.promises.unlink(indexFile);
          await fs.promises.rmdir(testDir);
        } catch (err) {
          // Ignore cleanup errors
        }
      })
    );
  });
});
