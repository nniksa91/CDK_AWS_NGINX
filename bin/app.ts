import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { NetworkDiscoveryStack } from '../lib/network-discovery-stack';
import { AppStack } from '../lib/app-stack';

const app = new cdk.App();

// You can pass context like: -c useDefaultVpc=true OR -c vpcName=my-vpc
// const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION };

const net = new NetworkDiscoveryStack(app, 'NetworkDiscoveryStack',);

new AppStack(app, 'EcsNginxWithCfStack', {
    vpc: net.vpc,
});
