'use strict';

import extend from 'extend';
import Base from '../base';
import join from '../deps/utils/join';
import Queue from 'promise-queue';
import BatchBlob from './blob';

const DEFAULT_OPTS = {
  concurrency: 5,
};

/**
 * The **BatchUpload** class allows to upload {@link Blob} objets to a Nuxeo Platform instance
 * using the batch upload API.
 *
 * It creates and maintains a batch id from the Nuxeo Platform instance.
 *
 * **Cannot directly be instantiated**
 *
 * @example
 * var Nuxeo = require('nuxeo')
 * var nuxeo = new Nuxeo({
 *  baseUrl: 'http://localhost:8080/nuxeo',
 *  auth: {
 *    username: 'Administrator',
 *    password: 'Administrator',
 *  }
 * });
 * var batch = nuxeo.batchUpload();
 * var nuxeoBlob = new Nuxeo.Blob(...);
 * batch.upload(nuxeoBlob).then((res) => {
 *    // res.blob instanceof BatchBlob === true
 *  });
 */
class BatchUpload extends Base {
  /**
   * Creates a BatchUpload.
   * @param {object} opts - The configuration options.
   * @param {Number} [opts.concurrency=5] - Number of concurrent uploads.
   */
  constructor(opts = {}) {
    const options = extend(true, {}, DEFAULT_OPTS, opts);
    super(options);
    this._url = join(options.url, 'upload/');
    this._nuxeo = options.nuxeo;
    this._uploadIndex = 0;
    Queue.configure(this._nuxeo.Promise);
    this._queue = new Queue(options.concurrency, Infinity);
    this._batchIdPromise = null;
    this._batchId = null;
    this._promises = [];
  }

  /**
   * Upload one or more blobs.
   * @param {...Blob} blobs - Blobs to be uploaded.
   * @returns {Promise} A Promise object resolved when all blobs are uploaded.
   *
   * @example
   * ...
   * nuxeoBatch.upload(blob1, blob2, blob3).then((res) => {
   *   // res.batch === nuxeoBatch
   *   // res.blobs[0] is the BatchBlob object related to blob1
   *   // res.blobs[1] is the BatchBlob object related to blob2
   *   // res.blobs[2] is the BatchBlob object related to blob3
   * }).catch(error => throw new Error(error));
   */
  upload(...blobs) {
    const promises = blobs.map((blob) => {
      const promise = this._queue.add(this._upload.bind(this, blob));
      this._promises.push(promise);
      return promise;
    });
    if (promises.length === 1) {
      return promises[0];
    }

    const Promise = this._nuxeo.Promise;
    return Promise.all(promises).then((batchBlobs) => {
      return {
        blobs: batchBlobs,
        batch: this,
      };
    });
  }

  _upload(blob) {
    if (!this._batchIdPromise) {
      this._batchIdPromise = this._fetchBatchId();
    }

    const uploadIndex = this._uploadIndex++;
    return this._batchIdPromise.then(() => {
      const options = {
        json: false,
        method: 'POST',
        url: join(this._url, this._batchId, uploadIndex),
        body: blob.content,
        headers: {
          'Cache-Control': 'no-cache',
          'X-File-Name': encodeURIComponent(blob.name),
          'X-File-Size': blob.size,
          'X-File-Type': blob.mimeType,
          'Content-Length': blob.size,
        },
        timeout: this._timeout,
        httpTimeout: this._httpTimeout,
        transactionTimeout: this._transactionTimeout,
        auth: this._auth,
      };

      return this._nuxeo.fetch(options);
    }).then((res) => {
      res.batchId = this._batchId;
      res.index = uploadIndex;
      return {
        blob: new BatchBlob(res),
        batch: this,
      };
    });
  }

  _fetchBatchId() {
    const opts = {
      method: 'POST',
      url: this._url,
      headers: this._headers,
      timeout: this._timeout,
      transactionTimeout: this._transactionTimeout,
      httpTimeout: this._httpTimeout,
      auth: this._auth,
    };

    const Promise = this._nuxeo.Promise;
    if (this._batchId) {
      return Promise.resolve(this);
    }
    return this._nuxeo.fetch(opts).then((res) => {
      this._batchId = res.batchId;
      return this;
    });
  }

  /**
   * Wait for all the current uploads to be finished. Note that it won't wait for uploads added after done() being call.
   * If an uploaded is added, you should call again done().
   * The {@link BatchUpload#isFinished} method can be used to know if the batch is finished.
   * @returns {Promise} A Promise object resolved when all the current uploads are finished.
   *
   * @example
   * ...
   * nuxeoBatch.upload(blob1, blob2, blob3);
   *  nuxeoBatch.done().then((res) => {
   *   // res.batch === nuxeoBatch
   *   // res.blobs[0] is the BatchBlob object related to blob1
   *   // res.blobs[1] is the BatchBlob object related to blob2
   *   // res.blobs[2] is the BatchBlob object related to blob3
   * }).catch(error => throw new Error(error));
   */
  done() {
    const Promise = this._nuxeo.Promise;
    return Promise.all(this._promises).then((batchBlobs) => {
      return {
        blobs: batchBlobs,
        batch: this,
      };
    });
  }

  /**
   * Returns weither the BatchUpload is finished, ie. has uploads running, or not.
   * @returns {Boolean} true if the BatchUpload is finished, false otherwise.
   */
  isFinished() {
    return this._queue.getQueueLength() === 0 && this._queue.getPendingLength() === 0;
  }

  /**
   * Cancels a BatchUpload.
   * @returns {Promise} A Promise object resolved with the BatchUpload itself.
   */
  cancel(opts) {
    const Promise = this._nuxeo.Promise;
    if (!this._batchIdPromise) {
      return Promise.resolve(this);
    }

    const path = join('upload', this._batchId);
    return this._batchIdPromise.then(() => {
      return this._nuxeo.request(path)
        .timeout(this._timeout)
        .httpTimeout(this._httpTimeout)
        .transactionTimeout(this._transactionTimeout)
        .delete(opts);
    }).then(() => {
      this._batchIdPromise = null;
      this._batchId = null;
      return this;
    });
  }

  /**
   * Fetch a blob at a given index from the batch.
   * @returns {Promise} A Promise object resolved with the BatchUpload itself and the BatchBlob.
   */
  fetchBlob(index, opts) {
    const Promise = this._nuxeo.Promise;
    if (!this._batchId) {
      return Promise.reject(new Error('No \'batchId\' set'));
    }

    let finalOptions = {
      method: 'GET',
      url: join(this._url, this._batchId, index),
      timeout: this._timeout,
      httpTimeout: this._httpTimeout,
      transactionTimeout: this._transactionTimeout,
      auth: this._auth,
    };
    finalOptions = extend(true, finalOptions, opts);

    return this._nuxeo.fetch(finalOptions).then((res) => {
      res.batchId = this._batchId;
      res.index = index;
      return {
        batch: this,
        blob: new BatchBlob(res),
      };
    });
  }

  /**
   * Fetch the blobs from the batch.
   * @returns {Promise} A Promise object resolved with the BatchUpload itself and the BatchBlobs.
   */
  fetchBlobs(opts) {
    const Promise = this._nuxeo.Promise;
    if (!this._batchId) {
      return Promise.reject(new Error('No \'batchId\' set'));
    }

    let finalOptions = {
      method: 'GET',
      url: join(this._url, this._batchId),
      timeout: this._timeout,
      httpTimeout: this._httpTimeout,
      transactionTimeout: this._transactionTimeout,
      auth: this._auth,
    };
    finalOptions = extend(true, finalOptions, opts);

    this._nuxeo.fetch(finalOptions).then((blobs) => {
      const batchBlobs = blobs.map((blob, index) => {
        blob.batchId = this._batchId;
        blob.index = index;
        return new BatchBlob(blob);
      });
      return {
        batch: this,
        blobs: batchBlobs,
      };
    });
  }
}

export default BatchUpload;
