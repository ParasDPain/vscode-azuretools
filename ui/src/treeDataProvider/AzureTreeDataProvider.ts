/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { Disposable, Event, EventEmitter, Extension, extensions, QuickPickOptions, TreeDataProvider, TreeItem, TreeItemCollapsibleState } from 'vscode';
import TelemetryReporter from 'vscode-extension-telemetry';
import { IActionContext, IAzureNode, IAzureParentTreeItem, IAzureQuickPickItem, IAzureUserInput, IChildProvider } from '../../index';
import { AzureAccount, AzureLoginStatus, AzureSubscription } from '../azure-account.api';
import { callWithTelemetryAndErrorHandling } from '../callWithTelemetryAndErrorHandling';
import { ArgumentError, UserCancelledError } from '../errors';
import { localize } from '../localize';
import { parseError } from '../parseError';
import { AzureNode } from './AzureNode';
import { AzureParentNode } from './AzureParentNode';
import { LoadMoreTreeItem } from './LoadMoreTreeItem';
import { RootNode } from './RootNode';
import { SubscriptionNode } from './SubscriptionNode';

const signInLabel: string = localize('signInLabel', 'Sign in to Azure...');
const createAccountLabel: string = localize('createAccountLabel', 'Create a Free Azure Account...');
const signInCommandId: string = 'azure-account.login';
const createAccountCommandId: string = 'azure-account.createAccount';

export class AzureTreeDataProvider implements TreeDataProvider<IAzureNode>, Disposable {
    public static readonly subscriptionContextValue: string = SubscriptionNode.contextValue;

    private _onDidChangeTreeDataEmitter: EventEmitter<IAzureNode> = new EventEmitter<IAzureNode>();

    private readonly _loadMoreCommandId: string;
    private _resourceProvider: IChildProvider;
    private _ui: IAzureUserInput;
    private _azureAccount: AzureAccount;
    private _customRootNodes: AzureNode[];
    private _telemetryReporter: TelemetryReporter | undefined;

    private _subscriptionNodes: IAzureNode[] = [];
    private _disposables: Disposable[] = [];

    constructor(resourceProvider: IChildProvider, loadMoreCommandId: string, ui: IAzureUserInput, telemetryReporter: TelemetryReporter | undefined, rootTreeItems?: IAzureParentTreeItem[]) {
        this._resourceProvider = resourceProvider;
        this._loadMoreCommandId = loadMoreCommandId;
        this._ui = ui;
        this._telemetryReporter = telemetryReporter;
        this._customRootNodes = rootTreeItems ? rootTreeItems.map((treeItem: IAzureParentTreeItem) => new RootNode(this, ui, treeItem)) : [];

        // Rather than expose 'AzureAccount' types in the index.ts contract, simply get it inside of this npm package
        const azureAccountExtension: Extension<AzureAccount> | undefined = extensions.getExtension<AzureAccount>('ms-vscode.azure-account');
        if (!azureAccountExtension) {
            throw new Error(localize('NoAccountExtensionError', 'The Azure Account Extension is required for the App Service tools.'));
        } else {
            this._azureAccount = azureAccountExtension.exports;
        }

        this._disposables.push(this._azureAccount.onFiltersChanged(async () => await this.refresh()));
        this._disposables.push(this._azureAccount.onStatusChanged(async (status: AzureLoginStatus) => {
            // Ignore status change to 'LoggedIn' and wait for the 'onFiltersChanged' event to fire instead
            // (so that the tree stays in 'Loading...' state until the filters are actually ready)
            if (status !== 'LoggedIn') {
                await this.refresh();
            }
        }));
    }

    public dispose(): void {
        for (const disposable of this._disposables) {
            disposable.dispose();
        }
    }

    public get onDidChangeTreeData(): Event<IAzureNode> {
        return this._onDidChangeTreeDataEmitter.event;
    }

    public getTreeItem(node: IAzureNode): TreeItem {
        return {
            label: node.treeItem.label,
            id: node.id,
            collapsibleState: node instanceof AzureParentNode ? TreeItemCollapsibleState.Collapsed : undefined,
            contextValue: node.treeItem.contextValue,
            iconPath: node.treeItem.iconPath,
            command: node.treeItem.commandId ? {
                command: node.treeItem.commandId,
                title: '',
                arguments: [node]
            } : undefined
        };
    }

    public async getChildren(node?: AzureParentNode): Promise<IAzureNode[]> {
        try {
            // tslint:disable:no-var-self
            const thisTree: AzureTreeDataProvider = this;
            return <IAzureNode[]>await callWithTelemetryAndErrorHandling('AzureTreeDataProvider.getChildren', this._telemetryReporter, undefined, async function (this: IActionContext): Promise<IAzureNode[]> {
                const actionContext: IActionContext = this;
                // tslint:enable:no-var-self
                actionContext.suppressErrorDisplay = true;
                actionContext.rethrowError = true;
                let result: IAzureNode[];

                if (node !== undefined) {
                    actionContext.properties.contextValue = node.treeItem.contextValue;

                    const cachedChildren: AzureNode[] = await node.getCachedChildren();
                    const hasMoreChildren: boolean = node.treeItem.hasMoreChildren();
                    actionContext.properties.hasMoreChildren = String(hasMoreChildren);

                    result = node.creatingNodes.concat(cachedChildren);
                    if (hasMoreChildren) {
                        result = result.concat(new AzureNode(node, new LoadMoreTreeItem(thisTree._loadMoreCommandId)));
                    }
                } else { // Root of tree
                    result = await thisTree.getRootNodes(actionContext);
                }

                this.measurements.childCount = result.length;
                return result;
            });
        } catch (error) {
            return [new AzureNode(node, {
                label: localize('errorNode', 'Error: {0}', parseError(error).message),
                contextValue: 'azureextensionui.error'
            })];
        }
    }

    public async refresh(node?: IAzureNode, clearCache: boolean = true): Promise<void> {
        if (clearCache) {
            if (node && node.treeItem.refreshLabel) {
                await node.treeItem.refreshLabel(node);
            }

            if (node instanceof AzureParentNode) {
                node.clearCache();
            }
        }

        this._onDidChangeTreeDataEmitter.fire(node);
    }

    public async loadMore(node: IAzureNode): Promise<void> {
        if (node.parent instanceof AzureParentNode) {
            await node.parent.loadMoreChildren();
            this._onDidChangeTreeDataEmitter.fire(node.parent);
        }
    }

    public async showNodePicker(expectedContextValues: string | string[], startingNode?: IAzureNode): Promise<IAzureNode> {
        if (!Array.isArray(expectedContextValues)) {
            expectedContextValues = [expectedContextValues];
        }

        // tslint:disable-next-line:strict-boolean-expressions
        let node: IAzureNode = startingNode || await this.promptForRootNode(expectedContextValues);
        while (!expectedContextValues.some((val: string) => node.treeItem.contextValue === val)) {
            if (node instanceof AzureParentNode) {
                node = await node.pickChildNode(expectedContextValues);
            } else {
                throw new Error(localize('noResourcesError', 'No matching resources found.'));
            }
        }

        return node;
    }

    public async findNode(id: string): Promise<IAzureNode | undefined> {
        let children: IAzureNode[] = await this.getChildren();

        // tslint:disable-next-line:no-constant-condition
        while (true) {
            const node: IAzureNode | undefined = children.find((child: IAzureNode) => id.startsWith(child.id));
            if (node && node.id === id) {
                return node;
            } else if (node instanceof AzureParentNode) {
                children = await node.getCachedChildren();
            } else {
                throw new Error(localize('noMatchingNode', 'Failed to find node with id "{0}".', id));
            }
        }
    }

    private async promptForRootNode(expectedContextValues: string | string[]): Promise<IAzureNode> {
        let picks: IAzureQuickPickItem<AzureNode | string>[];
        if (this._azureAccount.status === 'LoggedIn') {
            picks = this._subscriptionNodes.map((n: SubscriptionNode) => {
                return {
                    data: n,
                    label: n.treeItem.label,
                    // tslint:disable-next-line:no-non-null-assertion
                    description: n.subscription.subscriptionId!
                };
            });
        } else {
            picks = [
                { label: signInLabel, description: '', data: signInCommandId },
                { label: createAccountLabel, description: '', data: createAccountCommandId }
            ];
        }

        picks = picks.concat(this._customRootNodes
            .filter((n: AzureNode) => n.includeInNodePicker(<string[]>expectedContextValues))
            .map((n: AzureNode) => { return { data: n, description: '', label: n.treeItem.label }; }));

        const options: QuickPickOptions = { placeHolder: localize('selectSubscription', 'Select a Subscription') };
        const result: AzureNode | string = (await this._ui.showQuickPick(picks, options)).data;
        if (typeof result === 'string') {
            await vscode.commands.executeCommand(result);

            if (this._azureAccount.status === 'LoggedIn') {
                return await this.promptForRootNode(expectedContextValues);
            } else {
                throw new UserCancelledError();
            }
        } else {
            return result;
        }
    }

    private async getRootNodes(actionContext: IActionContext): Promise<IAzureNode[]> {
        actionContext.properties.isActivationEvent = 'true';
        actionContext.properties.contextValue = 'root';
        actionContext.properties.accountStatus = this._azureAccount.status;

        let nodes: IAzureNode[];

        this._subscriptionNodes = [];

        let commandLabel: string | undefined;
        if (this._azureAccount.status === 'Initializing' || this._azureAccount.status === 'LoggingIn') {
            nodes = [new AzureNode(undefined, {
                label: localize('loadingNode', 'Loading...'),
                commandId: signInCommandId,
                contextValue: 'azureCommandNode',
                id: signInCommandId,
                iconPath: {
                    light: path.join(__filename, '..', '..', '..', '..', 'resources', 'light', 'Loading.svg'),
                    dark: path.join(__filename, '..', '..', '..', '..', 'resources', 'dark', 'Loading.svg')
                }
            })];
        } else if (this._azureAccount.status === 'LoggedOut') {
            nodes = [
                new AzureNode(undefined, { label: signInLabel, commandId: signInCommandId, contextValue: 'azureCommandNode', id: signInCommandId }),
                new AzureNode(undefined, { label: createAccountLabel, commandId: createAccountCommandId, contextValue: 'azureCommandNode', id: createAccountCommandId })
            ];
        } else if (this._azureAccount.filters.length === 0) {
            commandLabel = localize('noSubscriptionsNode', 'No subscriptions found. Edit filters...');
            nodes = [new AzureNode(undefined, { label: commandLabel, commandId: 'azure-account.selectSubscriptions', contextValue: 'azureCommandNode', id: 'azure-account.selectSubscriptions' })];
        } else {
            this._subscriptionNodes = this._azureAccount.filters.map((subscriptionInfo: AzureSubscription) => {
                if (subscriptionInfo.subscription.subscriptionId === undefined || subscriptionInfo.subscription.displayName === undefined) {
                    throw new ArgumentError(subscriptionInfo);
                } else {
                    return new SubscriptionNode(this, this._ui, this._resourceProvider, subscriptionInfo.subscription.subscriptionId, subscriptionInfo.subscription.displayName, subscriptionInfo);
                }
            });
            nodes = this._subscriptionNodes;
        }

        return nodes.concat(this._customRootNodes);
    }
}
