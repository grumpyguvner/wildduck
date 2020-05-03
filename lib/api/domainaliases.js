'use strict';

const Joi = require('../joi');
const MongoPaging = require('mongo-cursor-pagination');
const ObjectID = require('mongodb').ObjectID;
const tools = require('../tools');
const roles = require('../roles');

module.exports = (db, server) => {
    /**
     * @api {get} /domainaliases List registered Domain Aliases
     * @apiName GetAliases
     * @apiGroup DomainAliases
     * @apiHeader {String} X-Access-Token Optional access token if authentication is enabled
     * @apiHeaderExample {json} Header-Example:
     * {
     *   "X-Access-Token": "59fc66a03e54454869460e45"
     * }
     *
     * @apiParam {String} [query] Partial match of a Domain Alias or Domain name
     * @apiParam {Number} [limit=20] How many records to return
     * @apiParam {Number} [page=1] Current page number. Informational only, page numbers start from 1
     * @apiParam {Number} [next] Cursor value for next page, retrieved from <code>nextCursor</code> response value
     * @apiParam {Number} [previous] Cursor value for previous page, retrieved from <code>previousCursor</code> response value
     *
     * @apiSuccess {Boolean} success Indicates successful response
     * @apiSuccess {Number} total How many results were found
     * @apiSuccess {Number} page Current page number. Derived from <code>page</code> query argument
     * @apiSuccess {String} previousCursor Either a cursor string or false if there are not any previous results
     * @apiSuccess {String} nextCursor Either a cursor string or false if there are not any next results
     * @apiSuccess {Object[]} results Aliases listing
     * @apiSuccess {String} results.id ID of the Domain Alias
     * @apiSuccess {String} results.alias Domain Alias
     * @apiSuccess {String} results.domain The domain this alias applies to
     *
     * @apiError error Description of the error
     *
     * @apiExample {curl} Example usage:
     *     curl -i http://localhost:8080/domainaliases
     *
     * @apiSuccessExample {json} Success-Response:
     *     HTTP/1.1 200 OK
     *     {
     *       "success": true,
     *       "total": 1,
     *       "page": 1,
     *       "previousCursor": false,
     *       "nextCursor": false,
     *       "results": [
     *         {
     *           "id": "59ef21aef255ed1d9d790e81",
     *           "alias": "example.net",
     *           "domain": "example.com"
     *         }
     *       ]
     *     }
     *
     * @apiErrorExample {json} Error-Response:
     *     HTTP/1.1 200 OK
     *     {
     *       "error": "Database error"
     *     }
     */
    server.get(
        { name: 'domainaliases', path: '/domainaliases' },
        tools.asyncifyJson(async (req, res, next) => {
            res.charSet('utf-8');

            const schema = Joi.object().keys({
                query: Joi.string()
                    .trim()
                    .empty('')
                    .max(255),
                limit: Joi.number()
                    .default(20)
                    .min(1)
                    .max(250),
                next: Joi.string()
                    .empty('')
                    .mongoCursor()
                    .max(1024),
                previous: Joi.string()
                    .empty('')
                    .mongoCursor()
                    .max(1024),
                page: Joi.number().default(1),
                sess: Joi.string().max(255),
                ip: Joi.string().ip({
                    version: ['ipv4', 'ipv6'],
                    cidr: 'forbidden'
                })
            });

            const result = Joi.validate(req.query, schema, {
                abortEarly: false,
                convert: true,
                allowUnknown: true
            });

            if (result.error) {
                res.status(400);
                res.json({
                    error: result.error.message,
                    code: 'InputValidationError'
                });
                return next();
            }

            // permissions check
            req.validate(roles.can(req.role).readAny('domainaliases'));

            let query = result.value.query;
            let limit = result.value.limit;
            let page = result.value.page;
            let pageNext = result.value.next;
            let pagePrevious = result.value.previous;

            let filter = query
                ? {
                      $or: [
                          {
                              alias: {
                                  $regex: query.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'),
                                  $options: ''
                              }
                          },

                          {
                              domain: {
                                  $regex: query.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'),
                                  $options: ''
                              }
                          }
                      ]
                  }
                : {};

            let total = await db.users.collection('domainaliases').countDocuments(filter);

            let opts = {
                limit,
                query: filter,
                fields: {
                    // FIXME: hack to keep alias in response
                    alias: true,
                    // FIXME: MongoPaging inserts fields value as second argument to col.find()
                    projection: {
                        _id: true,
                        alias: true,
                        domain: true
                    }
                },
                paginatedField: 'alias',
                sortAscending: true
            };

            if (pageNext) {
                opts.next = pageNext;
            } else if ((!page || page > 1) && pagePrevious) {
                opts.previous = pagePrevious;
            }

            let listing;
            try {
                listing = await MongoPaging.find(db.users.collection('domainaliases'), opts);
            } catch (err) {
                res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
                return next();
            }

            if (!listing.hasPrevious) {
                page = 1;
            }

            let response = {
                success: true,
                query,
                total,
                page,
                previousCursor: listing.hasPrevious ? listing.previous : false,
                nextCursor: listing.hasNext ? listing.next : false,
                results: (listing.results || []).map(domainData => ({
                    id: domainData._id.toString(),
                    alias: domainData.alias,
                    domain: domainData.domain
                }))
            };

            res.json(response);
            return next();
        })
    );

    /**
     * @api {post} /domainaliases Create new Domain Alias
     * @apiName PostDomainAlias
     * @apiGroup DomainAliases
     * @apiDescription Add a new Alias for a Domain. This allows to accept mail on username@domain and username@alias
     * @apiHeader {String} X-Access-Token Optional access token if authentication is enabled
     * @apiHeaderExample {json} Header-Example:
     * {
     *   "X-Access-Token": "59fc66a03e54454869460e45"
     * }
     *
     * @apiParam {String} alias Domain Alias
     * @apiParam {String} domain Domain name this Alias applies to
     *
     * @apiSuccess {Boolean} success Indicates successful response
     * @apiSuccess {String} id ID of the Domain Alias
     *
     * @apiError error Description of the error
     *
     * @apiExample {curl} Example usage:
     *     curl -i -XPOST http://localhost:8080/domainaliases \
     *     -H 'Content-type: application/json' \
     *     -d '{
     *       "domain": "example.com",
     *       "alias": "example.org"
     *     }'
     *
     * @apiSuccessExample {json} Success-Response:
     *     HTTP/1.1 200 OK
     *     {
     *       "success": true,
     *       "id": "59ef21aef255ed1d9d790e81"
     *     }
     *
     * @apiErrorExample {json} Error-Response:
     *     HTTP/1.1 200 OK
     *     {
     *       "error": "This user does not exist"
     *     }
     */
    server.post(
        '/domainaliases',
        tools.asyncifyJson(async (req, res, next) => {
            res.charSet('utf-8');

            const schema = Joi.object().keys({
                alias: Joi.string()
                    .max(255)
                    //.hostname()
                    .required(),
                domain: Joi.string()
                    .max(255)
                    //.hostname()
                    .required(),
                sess: Joi.string().max(255),
                ip: Joi.string().ip({
                    version: ['ipv4', 'ipv6'],
                    cidr: 'forbidden'
                })
            });

            const result = Joi.validate(req.params, schema, {
                abortEarly: false,
                convert: true
            });

            if (result.error) {
                res.status(400);
                res.json({
                    error: result.error.message,
                    code: 'InputValidationError'
                });
                return next();
            }

            // permissions check
            req.validate(roles.can(req.role).createAny('domainaliases'));

            let alias = tools.normalizeDomain(req.params.alias);
            let domain = tools.normalizeDomain(req.params.domain);

            let aliasData;

            try {
                aliasData = await db.users.collection('domainaliases').findOne(
                    {
                        alias
                    },
                    {
                        projection: { _id: 1 }
                    }
                );
            } catch (err) {
                res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
                return next();
            }

            if (aliasData) {
                res.json({
                    error: 'This domain alias already exists',
                    code: 'AliasExists'
                });
                return next();
            }

            let r;

            try {
                // insert alias address to email address registry
                r = await db.users.collection('domainaliases').insertOne({
                    alias,
                    domain,
                    created: new Date()
                });
            } catch (err) {
                res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
                return next();
            }

            let insertId = r.insertedId;

            res.json({
                success: !!insertId,
                id: insertId
            });
            return next();
        })
    );

    /**
     * @api {get} /domainaliases/resolve/:alias Resolve ID for a domain aias
     * @apiName ResolveDomainAlias
     * @apiGroup DomainAliases
     * @apiHeader {String} X-Access-Token Optional access token if authentication is enabled
     * @apiHeaderExample {json} Header-Example:
     * {
     *   "X-Access-Token": "59fc66a03e54454869460e45"
     * }
     *
     * @apiParam {String} alias Alias domain
     *
     * @apiSuccess {Boolean} success Indicates successful response
     * @apiSuccess {String} id Alias unique ID (24 byte hex)
     *
     * @apiError error Description of the error
     *
     * @apiExample {curl} Example usage:
     *     curl -i http://localhost:8080/domainaliases/resolve/example.com
     *
     * @apiSuccessExample {json} Success-Response:
     *     HTTP/1.1 200 OK
     *     {
     *       "success": true,
     *       "id": "59fc66a03e54454869460e45"
     *     }
     *
     * @apiErrorExample {json} Error-Response:
     *     HTTP/1.1 200 OK
     *     {
     *       "error": "This alias does not exist"
     *     }
     */
    server.get(
        '/domainaliases/resolve/:alias',
        tools.asyncifyJson(async (req, res, next) => {
            res.charSet('utf-8');

            const schema = Joi.object().keys({
                alias: Joi.string()
                    .max(255)
                    //.hostname()
                    .required(),
                sess: Joi.string().max(255),
                ip: Joi.string().ip({
                    version: ['ipv4', 'ipv6'],
                    cidr: 'forbidden'
                })
            });

            const result = Joi.validate(req.params, schema, {
                abortEarly: false,
                convert: true
            });

            if (result.error) {
                res.status(400);
                res.json({
                    error: result.error.message,
                    code: 'InputValidationError'
                });
                return next();
            }

            // permissions check
            req.validate(roles.can(req.role).readAny('domainaliases'));

            let alias = tools.normalizeDomain(result.value.alias);

            let aliasData;
            try {
                aliasData = await db.users.collection('domainaliases').findOne(
                    {
                        alias
                    },
                    {
                        projection: { _id: 1 }
                    }
                );
            } catch (err) {
                res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
                return next();
            }

            if (!aliasData) {
                res.json({
                    error: 'This alias does not exist',
                    code: 'AliasNotFound'
                });
                return next();
            }
            res.json({
                success: true,
                id: aliasData._id
            });

            return next();
        })
    );

    /**
     * @api {get} /domainaliases/:alias Request Alias information
     * @apiName GetDomainAlias
     * @apiGroup DomainAliases
     * @apiHeader {String} X-Access-Token Optional access token if authentication is enabled
     * @apiHeaderExample {json} Header-Example:
     * {
     *   "X-Access-Token": "59fc66a03e54454869460e45"
     * }
     *
     * @apiParam {String} alias ID of the Alias
     *
     * @apiSuccess {Boolean} success Indicates successful response
     * @apiSuccess {String} id ID of the Alias
     * @apiSuccess {String} alias Alias domain
     * @apiSuccess {String} domain Alias target
     * @apiSuccess {String} created Datestring of the time the alias was created
     *
     * @apiError error Description of the error
     *
     * @apiExample {curl} Example usage:
     *     curl -i http://localhost:8080/domainaliases/59ef21aef255ed1d9d790e7a
     *
     * @apiSuccessExample {json} Success-Response:
     *     HTTP/1.1 200 OK
     *     {
     *       "success": true,
     *       "id": "59ef21aef255ed1d9d790e7a",
     *       "alias": "example.net",
     *       "domain": "example.com",
     *       "created": "2017-10-24T11:19:10.911Z"
     *     }
     *
     * @apiErrorExample {json} Error-Response:
     *     HTTP/1.1 200 OK
     *     {
     *       "error": "This Alias does not exist"
     *     }
     */
    server.get(
        '/domainaliases/:alias',
        tools.asyncifyJson(async (req, res, next) => {
            res.charSet('utf-8');

            const schema = Joi.object().keys({
                alias: Joi.string()
                    .hex()
                    .lowercase()
                    .length(24)
                    .required(),
                sess: Joi.string().max(255),
                ip: Joi.string().ip({
                    version: ['ipv4', 'ipv6'],
                    cidr: 'forbidden'
                })
            });

            const result = Joi.validate(req.params, schema, {
                abortEarly: false,
                convert: true
            });

            if (result.error) {
                res.status(400);
                res.json({
                    error: result.error.message,
                    code: 'InputValidationError'
                });
                return next();
            }

            // permissions check
            req.validate(roles.can(req.role).readAny('domainaliases'));

            let alias = new ObjectID(result.value.alias);

            let aliasData;
            try {
                aliasData = await db.users.collection('domainaliases').findOne({
                    _id: alias
                });
            } catch (err) {
                res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
                return next();
            }

            if (!aliasData) {
                res.status(404);
                res.json({
                    error: 'Invalid or unknown alias',
                    code: 'AliasNotFound'
                });
                return next();
            }

            res.json({
                success: true,
                id: aliasData._id,
                alias: aliasData.alias,
                domain: aliasData.domain,
                created: aliasData.created
            });

            return next();
        })
    );

    /**
     * @api {delete} /domainaliases/:alias Delete an Alias
     * @apiName DeleteDomainAlias
     * @apiGroup DomainAliases
     * @apiHeader {String} X-Access-Token Optional access token if authentication is enabled
     * @apiHeaderExample {json} Header-Example:
     * {
     *   "X-Access-Token": "59fc66a03e54454869460e45"
     * }
     *
     * @apiParam {String} alias ID of the Alias
     *
     * @apiSuccess {Boolean} success Indicates successful response
     *
     * @apiError error Description of the error
     *
     * @apiExample {curl} Example usage:
     *     curl -i -XDELETE http://localhost:8080/domainaliases/59ef21aef255ed1d9d790e81
     *
     * @apiSuccessExample {json} Success-Response:
     *     HTTP/1.1 200 OK
     *     {
     *       "success": true
     *     }
     *
     * @apiErrorExample {json} Error-Response:
     *     HTTP/1.1 200 OK
     *     {
     *       "error": "Database error"
     *     }
     */
    server.del(
        '/domainaliases/:alias',
        tools.asyncifyJson(async (req, res, next) => {
            res.charSet('utf-8');

            const schema = Joi.object().keys({
                alias: Joi.string()
                    .hex()
                    .lowercase()
                    .length(24)
                    .required(),
                sess: Joi.string().max(255),
                ip: Joi.string().ip({
                    version: ['ipv4', 'ipv6'],
                    cidr: 'forbidden'
                })
            });

            const result = Joi.validate(req.params, schema, {
                abortEarly: false,
                convert: true
            });

            if (result.error) {
                res.status(400);
                res.json({
                    error: result.error.message,
                    code: 'InputValidationError'
                });
                return next();
            }

            // permissions check
            req.validate(roles.can(req.role).deleteAny('domainaliases'));

            let alias = new ObjectID(result.value.alias);

            let aliasData;
            try {
                aliasData = await db.users.collection('domainaliases').findOne(
                    {
                        _id: alias
                    },
                    {
                        projection: { _id: 1 }
                    }
                );
            } catch (err) {
                res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
                return next();
            }

            if (!aliasData) {
                res.status(404);
                res.json({
                    error: 'Invalid or unknown email alias identifier',
                    code: 'AliasNotFound'
                });
                return next();
            }

            let r;
            try {
                // delete address from email address registry
                r = await db.users.collection('domainaliases').deleteOne({
                    _id: alias
                });
            } catch (err) {
                res.json({
                    error: 'MongoDB Error: ' + err.message,
                    code: 'InternalDatabaseError'
                });
                return next();
            }

            res.json({
                success: !!r.deletedCount
            });
            return next();
        })
    );
};
