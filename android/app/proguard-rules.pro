# Debug builds are not minified. Keep the embedded server if you turn minify on later.
-keep class chat.porch.server.** { *; }
-keep class fi.iki.elonen.** { *; }
-keep class org.mindrot.jbcrypt.** { *; }
