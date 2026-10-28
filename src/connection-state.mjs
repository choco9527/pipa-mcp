import { APIError, transient } from './http.mjs'

const states = {
  authorization_required: ['signed_out', '尚未连接 PIPA，请发起连接并由用户确认。', 'pipa_connect'],
  authorization_pending: ['awaiting_user', '等待用户亲自打开授权链接并确认。', 'wait_for_user'],
  not_verified: ['unverified', '本地存在凭据，尚未通过服务器校验。', 'pipa_connection_status'],
  connected: ['connected', 'PIPA 连接正常，已通过服务器校验。', 'none'],
  authorization_expired: ['expired', 'PIPA Agent 授权已到期，请重新连接并由用户确认。', 'pipa_connect'],
  authorization_revoked: ['revoked', 'PIPA Agent 授权已撤销，请重新连接并由用户确认。', 'pipa_connect'],
  authorization_invalid: ['reconnect_required', 'PIPA Agent 凭据不可用，需要重新连接；无法据此确认是过期还是撤销。', 'pipa_connect'],
  refresh_result_uncertain: ['reconnect_required', '刷新凭据的结果不确定，不能确认授权是否有效。为避免重复消费，已停止刷新；请重新连接，并在网页检查可能遗留的连接。', 'pipa_connect'],
  network_error: ['offline', '暂时无法连接 PIPA，不代表授权过期。已有凭据保留，可稍后重试。', 'retry_later'],
  service_unavailable: ['offline', 'PIPA 服务暂不可用或请求受限，不代表授权过期。请稍后重试。', 'retry_later'],
  gateway_blocked: ['blocked', '机器接口被登录页或安全网关拦截。请检查 /api/agent/v1/* 的 Cloudflare 配置；不要复制网页 Cookie。', 'check_server_configuration'],
  server_configuration_error: ['blocked', 'PIPA 机器接口配置或响应异常，请检查服务地址、路由和版本；不要反复重新授权。', 'check_server_configuration'],
  credential_unavailable: ['error', '无法安全读取或保存本地凭据，请检查文件权限或文件锁；不要发送凭据文件。', 'check_local_credentials'],
  authorization_denied: ['signed_out', '用户已拒绝本次授权，未建立新连接。', 'pipa_connect'],
  pairing_expired: ['signed_out', '配对码已过期，请重新发起连接。', 'pipa_connect'],
}

export function describeConnection(code) {
  const [state, message, next_action] = states[code] ?? states.server_configuration_error
  return { state, code, message, next_action, reconnect_required: ['expired', 'revoked', 'reconnect_required'].includes(state),
    retryable: state === 'offline' }
}

export function connectionFailure(error) {
  const code = error instanceof APIError ? error.code.split(':', 1)[0] : ''
  if (['authorization_expired', 'authorization_revoked', 'refresh_result_uncertain', 'authorization_required'].includes(code)) return code
  if (code === 'gateway_login_or_non_json') return 'gateway_blocked'
  if (['invalid_grant', 'unauthorized', 'authorization_invalid', 'access_token_expired'].includes(code)) return 'authorization_invalid'
  if (error?.status === 401) return 'server_configuration_error'
  if (code === 'request_cancelled') return null
  if (code === 'network_error') return code
  if (error && transient(error)) return 'service_unavailable'
  if (['host_denied', 'origin_denied', 'invalid_server_response', 'invalid_tool_catalog', 'response_too_large'].includes(code)) return 'server_configuration_error'
  if (!(error instanceof APIError)) return 'credential_unavailable'
  return null // Business validation, version conflicts and missing scopes do not invalidate a grant.
}

export function authorizationFailure(error) {
  return ['authorization_expired', 'authorization_revoked', 'authorization_invalid'].includes(connectionFailure(error))
}

export function expiryNotice(status) {
  if (!status?.expires_soon || status.state !== 'connected') return undefined
  return { code: 'authorization_expiring_soon', expires_at: status.expires_at,
    message: 'PIPA Agent 授权将在 7 天内到期，当前操作正常。请告知用户；到期后重新连接，不要擅自断开现有连接。', next_action: 'inform_user' }
}
