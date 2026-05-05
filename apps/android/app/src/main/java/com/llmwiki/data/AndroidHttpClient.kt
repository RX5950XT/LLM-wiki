package com.llmwiki.data

import io.ktor.client.HttpClient
import io.ktor.client.engine.android.Android

object AndroidHttpClient {
    val instance: HttpClient by lazy {
        HttpClient(Android)
    }
}
