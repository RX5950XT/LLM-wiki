package com.llmwiki.data

import android.net.Uri
import com.llmwiki.BuildConfig
import java.net.URLEncoder

private const val DRIVE_RECONNECT_PATH = "llmwiki://auth/reconnect"

fun isDriveReconnectError(message: String): Boolean =
    Regex("google drive|drive token|drive access", RegexOption.IGNORE_CASE).containsMatchIn(message)

fun buildDriveReconnectUrl(source: String): String {
    val next = Uri.parse(DRIVE_RECONNECT_PATH)
        .buildUpon()
        .appendQueryParameter("source", source)
        .build()
        .toString()

    return BuildConfig.WEB_API_BASE_URL.trimEnd('/') +
        "/auth/reconnect?next=${URLEncoder.encode(next, Charsets.UTF_8)}"
}

fun parseDriveReconnectSource(uriString: String?): String? {
    val uri = uriString?.let(Uri::parse) ?: return null
    if (uri.scheme != "llmwiki" || uri.host != "auth" || uri.path != "/reconnect") return null
    return uri.getQueryParameter("source")
}
