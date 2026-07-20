/**
 * Warp 权限自动配置
 * 在用户认证后自动设置所有工具权限为 AlwaysAllow
 */

import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../../utils/logger.js';

const GRAPHQL_BASE = 'https://app.warp.dev/graphql/v2';

// 全部允许的权限配置
const ALL_ALLOW_PERMISSIONS = {
    name: 'Default',
    is_default_profile: true,
    apply_code_diffs: 'AlwaysAllow',
    read_files: 'AlwaysAllow',
    execute_commands: 'AlwaysAllow',
    write_to_pty: 'AlwaysAllow',
    mcp_permissions: 'AlwaysAllow',
    command_denylist: [],
    command_allowlist: [],
    directory_allowlist: [],
    mcp_allowlist: [],
    mcp_denylist: [],
    base_model: 'auto',
    coding_model: null,
    cli_agent_model: null,
    autosync_plans_to_warp_drive: true,
    web_search_enabled: true
};

// 创建 AI Execution Profile 的 mutation
const CREATE_PROFILE_MUTATION = `mutation CreateGenericStringObject($input: CreateGenericStringObjectInput!, $requestContext: RequestContext!) {
  createGenericStringObject(input: $input, requestContext: $requestContext) {
    __typename
    ... on CreateGenericStringObjectOutput {
      clientId
      genericStringObject {
        format
        metadata {
          creatorUid
          currentEditorUid
          isWelcomeObject
          lastEditorUid
          metadataLastUpdatedTs
          parent {
            __typename
            ... on FolderContainer {
              folderUid
            }
            ... on Space {
              uid
              type
            }
          }
          revisionTs
          trashedTs
          uid
        }
        permissions {
          guests {
            accessLevel
            source {
              __typename
              ... on FolderContainer {
                folderUid
              }
              ... on Space {
                uid
                type
              }
            }
            subject {
              __typename
              ... on UserGuest {
                firebaseUid
              }
              ... on PendingUserGuest {
                email
              }
            }
          }
          lastUpdatedTs
          anyoneLinkSharing {
            accessLevel
            source {
              __typename
              ... on FolderContainer {
                folderUid
              }
              ... on Space {
                uid
                type
              }
            }
          }
          space {
            uid
            type
          }
        }
        serializedModel
      }
      responseContext {
        serverVersion
      }
      revisionTs
    }
    ... on UserFacingError {
      error {
        __typename
        message
      }
      responseContext {
        serverVersion
      }
    }
  }
}`;

// 查询权限配置 - 尝试从 user 查询中获取
const QUERY_USER_OBJECTS = `query GetUserObjects($requestContext: RequestContext!) {
  user(requestContext: $requestContext) {
    __typename
    ... on UserOutput {
      user {
        profile {
          uid
        }
        genericStringObjects(format: AGENT_PERMISSIONS_PROFILE) {
          format
          metadata {
            uid
            revisionTs
            creatorUid
          }
          serializedModel
        }
      }
    }
    ... on UserFacingError {
      error {
        __typename
        message
      }
    }
  }
}`;

// 更新权限配置 - 完全参考抓包数据
const UPDATE_MUTATION = `mutation UpdateGenericStringObject($input: UpdateGenericStringObjectInput!, $requestContext: RequestContext!) {
  updateGenericStringObject(input: $input, requestContext: $requestContext) {
    __typename
    ... on UpdateGenericStringObjectOutput {
      responseContext {
        serverVersion
      }
      update {
        __typename
        ... on GenericStringObjectUpdateRejected {
          conflictingGenericStringObject {
            format
            metadata {
              creatorUid
              currentEditorUid
              isWelcomeObject
              lastEditorUid
              metadataLastUpdatedTs
              parent {
                __typename
                ... on FolderContainer {
                  folderUid
                }
                ... on Space {
                  uid
                  type
                }
              }
              revisionTs
              trashedTs
              uid
            }
            permissions {
              guests {
                accessLevel
                source {
                  __typename
                  ... on FolderContainer {
                    folderUid
                  }
                  ... on Space {
                    uid
                    type
                  }
                }
                subject {
                  __typename
                  ... on UserGuest {
                    firebaseUid
                  }
                  ... on PendingUserGuest {
                    email
                  }
                }
              }
              lastUpdatedTs
              anyoneLinkSharing {
                accessLevel
                source {
                  __typename
                  ... on FolderContainer {
                    folderUid
                  }
                  ... on Space {
                    uid
                    type
                  }
                }
              }
              space {
                uid
                type
              }
            }
            serializedModel
          }
          revisionTs
        }
        ... on ObjectUpdateSuccess {
          lastEditorUid
          revisionTs
        }
      }
    }
    ... on UserFacingError {
      error {
        __typename
        ... on SharedObjectsLimitExceeded {
          limit
          objectType
          message
        }
        ... on PersonalObjectsLimitExceeded {
          limit
          objectType
          message
        }
        ... on AccountDelinquencyError {
          message
        }
        ... on GenericStringObjectUniqueKeyConflict {
          message
        }
        ... on BudgetExceededError {
          message
        }
        ... on PaymentMethodDeclinedError {
          message
        }
        message
      }
      responseContext {
        serverVersion
      }
    }
  }
}
`;

/**
 * 构建请求头 - 完全参考抓包
 */
function buildHeaders(idToken, clientVersion) {
    return {
        'content-type': 'application/json',
        'authorization': `Bearer ${idToken}`,
        'x-warp-client-id': 'warp-app',
        'x-warp-client-version': clientVersion || 'v0.2026.01.14.08.15.stable_04',
        'x-warp-os-category': 'macOS',
        'x-warp-os-name': 'macOS',
        'x-warp-os-version': '15.6',
        'accept': '*/*',
        'accept-encoding': 'gzip,br'
    };
}

/**
 * 构建请求上下文 - 完全参考抓包
 */
function buildRequestContext(clientVersion) {
    return {
        clientContext: {
            version: clientVersion || 'v0.2026.01.14.08.15.stable_04'
        },
        osContext: {
            category: 'macOS',
            linuxKernelVersion: null,
            name: 'macOS',
            version: '15.6'
        }
    };
}

/**
 * 获取用户权限配置
 */
export async function getPermissionsConfig(idToken, clientVersion) {
    try {
        const response = await axios.post(
            `${GRAPHQL_BASE}?op=GetUserObjects`,
            {
                query: QUERY_USER_OBJECTS,
                variables: {
                    requestContext: buildRequestContext(clientVersion)
                },
                operationName: 'GetUserObjects'
            },
            { headers: buildHeaders(idToken, clientVersion) }
        );

        const userData = response.data?.data?.user;
        if (userData?.__typename === 'UserOutput') {
            const objects = userData.user?.genericStringObjects;
            if (objects && objects.length > 0) {
                logger.info('[WarpPermissions] Found permissions profile:', objects[0].metadata?.uid);
                return objects[0];
            }
        }

        logger.warn('[WarpPermissions] No permissions profile found');
        logger.info('[WarpPermissions] Response:', JSON.stringify(response.data).substring(0, 500));
        return null;
    } catch (error) {
        logger.error('[WarpPermissions] Failed to get permissions:', error.message);
        if (error.response?.data) {
            logger.error('[WarpPermissions] Error response:', JSON.stringify(error.response.data).substring(0, 500));
        }
        return null;
    }
}

/**
 * 检查配置是否已经是全部允许
 */
function isAllAllow(config) {
    return config.apply_code_diffs === 'AlwaysAllow' &&
           config.read_files === 'AlwaysAllow' &&
           config.execute_commands === 'AlwaysAllow' &&
           config.write_to_pty === 'AlwaysAllow' &&
           config.mcp_permissions === 'AlwaysAllow' &&
           (!config.command_denylist || config.command_denylist.length === 0);
}

/**
 * 更新权限配置为全部允许
 */
export async function updatePermissionsToAllAllow(idToken, clientVersion, existingConfig = null) {
    try {
        // 获取现有配置
        if (!existingConfig) {
            existingConfig = await getPermissionsConfig(idToken, clientVersion);
        }

        if (!existingConfig) {
            logger.warn('[WarpPermissions] No existing config found, cannot update');
            return false;
        }

        const uid = existingConfig.metadata?.uid;
        const revisionTs = existingConfig.metadata?.revisionTs;

        if (!uid || !revisionTs) {
            logger.warn('[WarpPermissions] Missing uid or revisionTs');
            return false;
        }

        // 检查是否已经是全部允许
        try {
            const currentModel = JSON.parse(existingConfig.serializedModel || '{}');
            if (isAllAllow(currentModel)) {
                logger.info('[WarpPermissions] Already all allow, skipping update');
                return true;
            }
        } catch (e) {
            logger.warn('[WarpPermissions] Failed to parse current model:', e.message);
        }

        logger.info('[WarpPermissions] Updating permissions to all allow, uid:', uid);

        // 更新为全部允许 - 完全参考抓包格式
        const response = await axios.post(
            `${GRAPHQL_BASE}?op=UpdateGenericStringObject`,
            {
                query: UPDATE_MUTATION,
                variables: {
                    input: {
                        revisionTs: revisionTs,
                        serializedModel: JSON.stringify(ALL_ALLOW_PERMISSIONS),
                        uid: uid
                    },
                    requestContext: buildRequestContext(clientVersion)
                },
                operationName: 'UpdateGenericStringObject'
            },
            { headers: buildHeaders(idToken, clientVersion) }
        );

        const result = response.data?.data?.updateGenericStringObject;
        if (result?.__typename === 'UpdateGenericStringObjectOutput') {
            const update = result.update;
            if (update?.__typename === 'ObjectUpdateSuccess') {
                logger.info('[WarpPermissions] Successfully updated to all allow');
                return true;
            } else if (update?.__typename === 'GenericStringObjectUpdateRejected') {
                logger.warn('[WarpPermissions] Update rejected, conflict detected');
                return false;
            }
        } else if (result?.__typename === 'UserFacingError') {
            logger.error('[WarpPermissions] Update failed:', result.error?.message);
            return false;
        }

        logger.warn('[WarpPermissions] Unexpected response:', JSON.stringify(response.data));
        return false;
    } catch (error) {
        logger.error('[WarpPermissions] Failed to update permissions:', error.message);
        if (error.response?.data) {
            logger.error('[WarpPermissions] Response:', JSON.stringify(error.response.data));
        }
        return false;
    }
}

export { ALL_ALLOW_PERMISSIONS };

/**
 * 从 JWT token 中提取用户 UID
 */
function extractUidFromToken(idToken) {
    try {
        const parts = idToken.split('.');
        if (parts.length !== 3) return null;
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
        return payload.user_id || payload.sub;
    } catch (e) {
        logger.warn('[WarpPermissions] Failed to extract uid from token:', e.message);
        return null;
    }
}

/**
 * 创建 AI Execution Profile
 */
export async function createExecutionProfile(idToken, clientVersion) {
    const userUid = extractUidFromToken(idToken);
    if (!userUid) {
        logger.error('[WarpPermissions] Cannot create profile: failed to extract user uid');
        return null;
    }

    const clientId = `Client-${uuidv4()}`;
    const serializedModel = JSON.stringify(ALL_ALLOW_PERMISSIONS);

    try {
        const response = await axios.post(
            `${GRAPHQL_BASE}?op=CreateGenericStringObject`,
            {
                query: CREATE_PROFILE_MUTATION,
                variables: {
                    input: {
                        genericStringObject: {
                            clientId: clientId,
                            entrypoint: 'Unknown',
                            format: 'JsonAIExecutionProfile',
                            initialFolderId: null,
                            serializedModel: serializedModel,
                            uniquenessKey: null
                        },
                        owner: {
                            uid: userUid,
                            type: 'User'
                        }
                    },
                    requestContext: buildRequestContext(clientVersion)
                },
                operationName: 'CreateGenericStringObject'
            },
            { headers: buildHeaders(idToken, clientVersion) }
        );

        const result = response.data?.data?.createGenericStringObject;
        if (result?.__typename === 'CreateGenericStringObjectOutput') {
            const profileUid = result.genericStringObject?.metadata?.uid;
            logger.info('[WarpPermissions] Created execution profile:', profileUid);
            return {
                uid: profileUid,
                userUid: userUid,
                serializedModel: result.genericStringObject?.serializedModel
            };
        } else if (result?.__typename === 'UserFacingError') {
            logger.error('[WarpPermissions] Create profile failed:', result.error?.message);
            return null;
        }

        logger.warn('[WarpPermissions] Unexpected create response:', JSON.stringify(response.data).substring(0, 500));
        return null;
    } catch (error) {
        logger.error('[WarpPermissions] Failed to create profile:', error.message);
        if (error.response?.data) {
            logger.error('[WarpPermissions] Response:', JSON.stringify(error.response.data).substring(0, 500));
        }
        return null;
    }
}

/**
 * 获取或创建 Execution Profile
 */
export async function getOrCreateExecutionProfile(idToken, clientVersion) {
    const existing = await getExecutionProfile(idToken, clientVersion);
    if (existing) {
        logger.info('[WarpPermissions] Using existing execution profile:', existing.uid);
        return existing;
    }
    logger.info('[WarpPermissions] No existing profile, creating new one');
    return await createExecutionProfile(idToken, clientVersion);
}

/**
 * 查询现有的 JsonAIExecutionProfile
 */
async function getExecutionProfile(idToken, clientVersion) {
    try {
        const response = await axios.post(
            `${GRAPHQL_BASE}?op=GetUserObjects`,
            {
                query: QUERY_USER_OBJECTS,
                variables: {
                    requestContext: buildRequestContext(clientVersion)
                },
                operationName: 'GetUserObjects'
            },
            { headers: buildHeaders(idToken, clientVersion) }
        );

        const userData = response.data?.data?.user;
        if (userData?.__typename === 'UserOutput') {
            const objects = userData.user?.genericStringObjects;
            if (objects && objects.length > 0) {
                for (const obj of objects) {
                    if (obj.format === 'JsonAIExecutionProfile') {
                        return {
                            uid: obj.metadata?.uid,
                            userUid: obj.metadata?.creatorUid,
                            serializedModel: obj.serializedModel
                        };
                    }
                }
            }
        }
        return null;
    } catch (error) {
        logger.warn('[WarpPermissions] Failed to get execution profile:', error.message);
        return null;
    }
}
