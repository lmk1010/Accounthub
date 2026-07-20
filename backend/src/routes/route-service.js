export async function resolveRouteApiService(context, createApiService) {
    return await (context.apiService || createApiService(context.config));
}
