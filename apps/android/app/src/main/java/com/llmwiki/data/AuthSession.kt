package com.llmwiki.data

import io.github.jan.supabase.SupabaseClient
import io.github.jan.supabase.auth.auth

suspend fun SupabaseClient.requireAccessToken(forceRefresh: Boolean = false): String? {
    auth.awaitInitialization()
    val currentToken = auth.currentAccessTokenOrNull()
        ?: auth.currentSessionOrNull()?.accessToken
    if (!forceRefresh && currentToken != null) {
        return currentToken
    }

    if (forceRefresh || auth.currentSessionOrNull() != null) {
        runCatching { auth.refreshCurrentSession() }
    }

    return auth.currentAccessTokenOrNull()
        ?: auth.currentSessionOrNull()?.accessToken
}
