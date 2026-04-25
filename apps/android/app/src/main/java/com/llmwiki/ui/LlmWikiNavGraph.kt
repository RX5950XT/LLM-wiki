package com.llmwiki.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.llmwiki.ui.auth.AuthScreen
import com.llmwiki.ui.auth.AuthState
import com.llmwiki.ui.wiki.WikiScreen

@Composable
fun LlmWikiNavGraph(shareUrl: String? = null) {
    val navController = rememberNavController()

    // Persist auth result across recompositions without putting it in the back stack
    var accountName by rememberSaveable { mutableStateOf("") }

    NavHost(navController = navController, startDestination = "auth") {
        composable("auth") {
            AuthScreen(
                onAuthenticated = { authState ->
                    if (authState is AuthState.Success) {
                        accountName = authState.accountName
                        val wsId = authState.workspaceId
                        val route = if (wsId != null) "wiki?workspaceId=$wsId" else "wiki"
                        navController.navigate(route) {
                            popUpTo("auth") { inclusive = true }
                        }
                    }
                },
            )
        }
        composable(
            route = "wiki?workspaceId={workspaceId}",
            arguments = listOf(navArgument("workspaceId") {
                type = NavType.StringType
                nullable = true
                defaultValue = null
            }),
        ) { backStackEntry ->
            WikiScreen(
                workspaceId = backStackEntry.arguments?.getString("workspaceId"),
                accountName = accountName,
                shareUrl = shareUrl,
            )
        }
    }
}
