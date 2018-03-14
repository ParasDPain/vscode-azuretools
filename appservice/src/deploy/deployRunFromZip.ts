/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// import * as fs from 'fs';
import * as vscode from 'vscode';
import { TelemetryProperties } from 'vscode-azureextensionui';
// import { DialogResponses } from '../DialogResponses';
import * as FileUtilities from '../FileUtilities';
// import { getKuduClient } from '../getKuduClient';
import { localize } from '../localize';
import { SiteClient } from '../SiteClient';
import { formatDeployLog } from './formatDeployLog';
// import { waitForDeploymentToComplete } from './waitForDeploymentToComplete';

export async function deployRunFromZip(client: SiteClient, fsPath: string, outputChannel: vscode.OutputChannel, configurationSectionName: string, telemetryProperties?: TelemetryProperties): Promise<void> {
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
        const zipDeployConfig: vscode.WorkspaceConfiguration = vscode.workspace.getConfiguration(configurationSectionName, vscode.Uri.file(fsPath));
        // tslint:disable-next-line:no-backbone-get-set-outside-model
        const globPattern: string = zipDeployConfig.get<string>('zipGlobPattern');
        // tslint:disable-next-line:no-backbone-get-set-outside-model
        const ignorePattern: string | string[] = zipDeployConfig.get<string | string[]>('zipIgnorePattern');

        zipFilePath = await FileUtilities.zipDirectory(fsPath, globPattern, ignorePattern);
    } else {
        throw new Error(localize('NotAZipError', 'Path specified is not a folder or a zip file'));
    }

    try {
        outputChannel.appendLine(formatDeployLog(client, localize('deployStart', 'Starting deployment...')));
        // await waitForDeploymentToComplete(client, kuduClient, outputChannel);
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
