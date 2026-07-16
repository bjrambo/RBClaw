package com.rbclaw.android.api

import com.rbclaw.android.model.RoomActivity
import com.rbclaw.android.model.RoomMessage
import com.rbclaw.android.model.RoomSummary
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import org.json.JSONObject

class RBClawApi(
    baseUrl: String,
    private val token: String,
) {
    private val baseUrl = normalizeBaseUrl(baseUrl)

    private fun normalizeBaseUrl(value: String): String {
        val trimmed = value.trim().trimEnd('/')
        require(trimmed.isNotEmpty()) { "Enter the RBClaw dashboard URL" }

        val parsed = try {
            URL(trimmed)
        } catch (_: Exception) {
            throw IllegalArgumentException("Enter a valid RBClaw dashboard URL")
        }
        require(parsed.protocol == "http" || parsed.protocol == "https") {
            "Dashboard URL must use http:// or https://"
        }
        require(parsed.host.isNotBlank()) { "Dashboard URL must include a host" }
        require(parsed.userInfo == null) { "Dashboard URL must not contain credentials" }
        require(parsed.query == null && parsed.ref == null) {
            "Dashboard URL must not contain a query or fragment"
        }
        if (parsed.protocol == "http") {
            require(isTrustedCleartextHost(parsed.host)) {
                "Public dashboard hosts must use https://"
            }
        }
        return trimmed
    }

    private fun isTrustedCleartextHost(host: String): Boolean {
        val normalized = host.lowercase().removePrefix("[").removeSuffix("]")
        if (
            normalized == "localhost" ||
            normalized == "::1" ||
            normalized.endsWith(".localhost") ||
            normalized.endsWith(".ts.net") ||
            (!normalized.contains('.') && !normalized.contains(':'))
        ) {
            return true
        }

        if (
            normalized.contains(':') &&
            (normalized.startsWith("fc") ||
                normalized.startsWith("fd") ||
                normalized.startsWith("fe80:"))
        ) {
            return true
        }

        val octets = normalized.split('.').map { it.toIntOrNull() }
        if (octets.size != 4 || octets.any { it == null || it !in 0..255 }) return false
        val first = requireNotNull(octets[0])
        val second = requireNotNull(octets[1])
        return first == 10 ||
            first == 127 ||
            (first == 172 && second in 16..31) ||
            (first == 192 && second == 168) ||
            (first == 100 && second in 64..127)
    }

    fun health(): Boolean {
        val payload = request("GET", "/api/health")
        return JSONObject(payload).optBoolean("ok", false)
    }

    fun rooms(): List<RoomSummary> {
        val payload = request("GET", "/api/rooms-timeline")
        val root = JSONObject(payload)
        return root.keys().asSequence().mapNotNull { key ->
            root.optJSONObject(key)?.let { parseRoomSummary(it) }
        }.sortedBy { it.name.lowercase() }.toList()
    }

    fun roomTimeline(jid: String): RoomActivity {
        val payload = request("GET", "/api/rooms/${encode(jid)}/timeline")
        val room = JSONObject(payload)
        val messages = room.optJSONArray("messages") ?: return RoomActivity(parseRoomSummary(room), emptyList())
        return RoomActivity(
            parseRoomSummary(room),
            (0 until messages.length()).mapNotNull { index ->
                messages.optJSONObject(index)?.let { message ->
                    RoomMessage(
                        senderName = message.optString("senderName", message.optString("sender", "")),
                        content = message.optString("content", ""),
                        timestamp = message.optString("timestamp", ""),
                        fromMe = message.optBoolean("isFromMe", false),
                    )
                }
            },
        )
    }

    fun sendRoomMessage(jid: String, text: String, nickname: String): Boolean {
        val body = JSONObject()
            .put("requestId", UUID.randomUUID().toString())
            .put("text", text)
            .put("nickname", nickname.ifBlank { "android" })
        val payload = request("POST", "/api/rooms/${encode(jid)}/messages", body.toString())
        return JSONObject(payload).optBoolean("ok", false)
    }

    private fun parseRoomSummary(room: JSONObject): RoomSummary {
        val messages = room.optJSONArray("messages")
        val latest = if (messages != null && messages.length() > 0) {
            messages.optJSONObject(messages.length() - 1)?.optString("content", "") ?: ""
        } else {
            ""
        }
        return RoomSummary(
            jid = room.optString("jid"),
            name = room.optString("name", room.optString("jid")),
            status = room.optString("status", "unknown"),
            latestText = latest.take(120),
        )
    }

    private fun request(method: String, path: String, body: String? = null): String {
        val connection = URL("$baseUrl$path").openConnection() as HttpURLConnection
        connection.requestMethod = method
        connection.connectTimeout = 8_000
        connection.readTimeout = 12_000
        connection.setRequestProperty("Accept", "application/json")
        if (token.isNotBlank()) connection.setRequestProperty("Authorization", "Bearer $token")
        if (body != null) {
            val bytes = body.toByteArray(Charsets.UTF_8)
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json")
            connection.setRequestProperty("Content-Length", bytes.size.toString())
            connection.outputStream.use { it.write(bytes) }
        }
        val status = connection.responseCode
        val stream = if (status in 200..299) connection.inputStream else connection.errorStream
        val response = stream?.use {
            BufferedReader(InputStreamReader(it, Charsets.UTF_8)).readText()
        } ?: ""
        connection.disconnect()
        if (status !in 200..299) {
            val message = response.ifBlank { "HTTP $status" }
            throw IllegalStateException(message)
        }
        return response
    }

    private fun encode(value: String): String =
        java.net.URLEncoder.encode(value, Charsets.UTF_8.name()).replace("+", "%20")
}
