type PromiseV2Plugin = {
    id: string;
    setup: (ctx: {
        aisdk: {
            sdk: (callback: (event: any) => void) => Promise<void>;
            language: (callback: (event: any) => void) => Promise<void>;
        };
    }) => Promise<void>;
};
declare const plugin: PromiseV2Plugin;
export default plugin;
