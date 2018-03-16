/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// import * as fs from 'fs';
import * as vscode from 'vscode';
import { TelemetryProperties } from 'vscode-azureextensionui';
// import { DialogResponses } from '../DialogResponses';
import * as FileUtilities from '../FileUtilities';
import { localize } from '../localize';
import { SiteClient } from '../SiteClient';
import { formatDeployLog } from './formatDeployLog';
import { StringDictionary } from 'azure-arm-website/lib/models';
import { StorageAccountListResult } from 'azure-arm-storage/lib/models';
import { uiUtils } from '../utils/uiUtils';
import { IQuickPickItemWithData } from '../wizard/IQuickPickItemWithData';
import { StorageAccount, StorageAccountListKeysResult } from 'azure-arm-storage/lib/models';
import * as azureStorage from "azure-storage";

export async function deployRunFromZip(client: SiteClient, fsPath: string, outputChannel: vscode.OutputChannel, telemetryProperties?: TelemetryProperties): Promise<void> {
    // if (confirmDeployment) {
    //     const warning: string = localize('zipWarning', 'Are you sure you want to deploy to "{0}"? This will overwrite any previous deployment and cannot be undone.', client.fullName);
    //     if (await vscode.window.showWarningMessage(warning, DialogResponses.yes, DialogResponses.cancel) !== DialogResponses.yes) {
    if (telemetryProperties) {
        telemetryProperties.cancelStep = 'confirmDestructiveDeployment';
    }
    //         throw new UserCancelledError();
    //     }
    // }
    // does this count as a destructive action?

    outputChannel.show();

    let zipFilePath: string;
    let createdZip: boolean = false;
    if (FileUtilities.getFileExtension(fsPath) === 'zip') {
        zipFilePath = fsPath;
    } else if (await FileUtilities.isDirectory(fsPath)) {
        createdZip = true;
        outputChannel.appendLine(formatDeployLog(client, localize('zipCreate', 'Creating zip package...')));
        zipFilePath = await FileUtilities.zipDirectory(fsPath);
    } else {
        throw new Error(localize('NotAZipError', 'Path specified is not a folder or a zip file'));
    }

    try {
        const storageAccounts: StorageAccountListResult = await client.listStorageAccounts();
        const storageAccountQuickPicks: IQuickPickItemWithData<StorageAccount>[] = storageAccounts.map((sa: StorageAccount) => {
            return {
                label: sa.name,
                description: '',
                data: sa
            };
        });

        const storageAccount: StorageAccount = (await uiUtils.showQuickPickWithData(storageAccountQuickPicks, { placeHolder: 'Choose a storage account to host the zip file.', ignoreFocusOut: true })).data;
        const blobService: azureStorage.BlobService = await createBlobService(client, storageAccount);
        const blobUrl: string = await createBlobFromZip(blobService, zipFilePath);
        outputChannel.appendLine(formatDeployLog(client, localize('deployStart', 'Starting deployment...')));
        const WEBSITE_USE_ZIP: string = 'WEBSITE_USE_ZIP';
        const appSettings: StringDictionary = await client.listApplicationSettings();
        appSettings.properties[WEBSITE_USE_ZIP] = blobUrl.replace('%3A', ':');
        await client.updateApplicationSettings(appSettings);
    } catch (error) {
        // tslint:disable-next-line:no-unsafe-any
        if (error && error.response && error.response.body) {
            // Autorest doesn't support plain/text as a MIME type, so we have to get the error message from the response body ourselves
            // https://github.com/Azure/autorest/issues/1527
            // tslint:disable-next-line:no-unsafe-any
            throw new Error(error.response.body);
        } else {
            throw error;
        }
    } finally {
        if (createdZip) {
            await FileUtilities.deleteFile(zipFilePath);
        }
    }
}

function parseAzureResourceId(resourceId: string): { [key: string]: string } {
    const invalidIdErr: Error = new Error('Invalid Account ID.');
    const result: {} = {};

    if (!resourceId || resourceId.length < 2 || resourceId.charAt(0) !== '/') {
        throw invalidIdErr;
    }

    const parts: string[] = resourceId.substring(1).split('/');

    if (parts.length % 2 !== 0) {
        throw invalidIdErr;
    }

    for (let i: number = 0; i < parts.length; i += 2) {
        const key: string = parts[i];
        const value: string = parts[i + 1];

        if (key === '' || value === '') {
            throw invalidIdErr;
        }

        result[key] = value;
    }

    return result;
}

async function createBlobService(client: SiteClient, sa: StorageAccount): Promise<azureStorage.BlobService> {
    const parsedId: { [key: string]: string } = parseAzureResourceId(sa.id);
    const resourceGroups: string = 'resourceGroups';
    const saResourceGroup: string = parsedId[resourceGroups];
    const storageAccountKeys: StorageAccountListKeysResult = await client.listStorageAccountKeys(saResourceGroup, sa.name);
    return (await azureStorage.createBlobService(sa.name, storageAccountKeys.keys[0].value));

}

async function createBlobFromZip(blobService: azureStorage.BlobService, zipFilePath: string): Promise<string> {
    const containerName: string = 'azureappservice-run-from-zip';
    const zipName: string = zipFilePath.substring(zipFilePath.lastIndexOf('/')); // parse the file path because Storage doesn't like C: in the blob name
    // tslint:disable-next-line:no-any
    await new Promise<void>((resolve: any, reject: any): void => {
        blobService.createContainerIfNotExists(containerName, { publicAccessLevel: 'blob' }, (err: Error) => {
        if (err) {
            reject(err);
        } else {
            resolve();
        }
     });
    });

    // tslint:disable-next-line:no-any
    await new Promise<void>((resolve: any, reject: any): void => {
        blobService.createBlockBlobFromLocalFile(containerName, zipName, zipFilePath, (error: Error, _result: azureStorage.BlobService.BlobResult, _response: azureStorage.ServiceResponse) => {
            if (!!error) {
                // tslint:disable-next-line:no-any
                const errorAny: any = error;
                if (!!errorAny.code) {
                    let humanReadableMessage: string = `Unable to save '${zipName}', blob service returned error code "${errorAny.code}"`;
                    switch (errorAny.code) {
                        case 'ENOTFOUND':
                            humanReadableMessage +=  ' - Please check connection.';
                            break;
                        default:
                            break;
                    }
                    reject(humanReadableMessage);
                } else {
                    reject(error);
                }
            } else {
                resolve();
            }
        });
    });
    const sasToken: string = blobService.generateSharedAccessSignature(containerName, zipName, <azureStorage.common.SharedAccessPolicy>{ AccessPolicy: {
        Permissions: azureStorage.BlobUtilities.SharedAccessPermissions.READ,
        Start: azureStorage.date.secondsFromNow(-10),
        // for clock desync
        Expiry: azureStorage.date.minutesFromNow(60),
        ResourceTypes: azureStorage.BlobUtilities.BlobContainerPublicAccessType.BLOB
        }
    });

    return blobService.getUrl(containerName, zipName, sasToken, true);
}
