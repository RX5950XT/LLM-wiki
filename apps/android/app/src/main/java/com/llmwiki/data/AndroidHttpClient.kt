package com.llmwiki.data

import io.ktor.client.HttpClient
import io.ktor.client.engine.android.Android
import io.ktor.client.plugins.HttpTimeout

object AndroidHttpClient {
    val instance: HttpClient by lazy {
        HttpClient(Android) {
            install(HttpTimeout) {
                connectTimeoutMillis = 10_000
                // Lint POST responds with zero bytes until the LLM pass finishes
                // (server budget 300s) — the read timeout must cover that
                socketTimeoutMillis = 310_000
                requestTimeoutMillis = 320_000
            }
        }
    }
}
