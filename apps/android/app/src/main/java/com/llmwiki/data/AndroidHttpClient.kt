package com.llmwiki.data

import io.ktor.client.HttpClient
import io.ktor.client.engine.android.Android
import io.ktor.client.plugins.HttpTimeout

object AndroidHttpClient {
    val instance: HttpClient by lazy {
        HttpClient(Android) {
            install(HttpTimeout) {
                connectTimeoutMillis = 10_000
                socketTimeoutMillis = 120_000
                requestTimeoutMillis = 300_000
            }
        }
    }
}
